// Parses GP payloads (CelesTrak OMM JSON, worker `TleRecord` JSON, TLE text) into
// `GpRecord`s. Keep this module, SatelliteCatalog and Orbit Cesium-free for node-env vitest.

import { json2satrec, twoline2satrec, type OMMJsonObject, type SatRec } from "satellite.js";

import type { OrbitClass } from "../../config/orbitClass";
import type { SatelliteMetadata } from "../../config/satelliteMetadata";

/**
 * `metadata` is optional for hand-built records; every record from parseGpPayload
 * carries at least the derived `orbitClass`.
 */
export type GpRecord = ({ kind: "omm"; omm: OMMJsonObject } | { kind: "tle"; name: string; line1: string; line2: string }) & {
  metadata?: SatelliteMetadata;
};

/** Worker `TleRecord` (worker/src/gp/types.ts). */
interface WorkerTleRecord {
  OBJECT_NAME?: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
}

function isWorkerTleRecord(obj: unknown): obj is WorkerTleRecord {
  return (
    typeof obj === "object" && obj !== null && typeof (obj as Record<string, unknown>).TLE_LINE1 === "string" && typeof (obj as Record<string, unknown>).TLE_LINE2 === "string"
  );
}

/** Satnum is in columns 3-7 (1-indexed) of a TLE line. */
function satnumFromTleLine(line: string): string {
  return line.substring(2, 7).trim();
}

/** Strip a leading "0 " name prefix used by some 3-line TLE feeds. */
function stripNamePrefix(name: string): string {
  return name.startsWith("0 ") ? name.substring(2) : name;
}

/** "00005" -> "5"; alpha-5 designators ("E8493") stay as they are. */
function normalizeSatnum(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return String(parseInt(trimmed, 10));
  }
  return trimmed;
}

const MINUTES_PER_DAY = 1440;

/**
 * TLE line 2 columns (1-indexed): inclination (°) in 9-16, eccentricity in 27-33 with an
 * assumed leading decimal point, mean motion (rev/day) in 53-63.
 */
function classifyingElements(r: GpRecord): { meanMotionRevPerDay: number; eccentricity: number; inclinationDeg: number } {
  if (r.kind === "omm") {
    return { meanMotionRevPerDay: Number(r.omm.MEAN_MOTION), eccentricity: Number(r.omm.ECCENTRICITY), inclinationDeg: Number(r.omm.INCLINATION) };
  }
  return {
    meanMotionRevPerDay: Number(r.line2.substring(52, 63)),
    eccentricity: Number(`0.${r.line2.substring(26, 33).trim()}`),
    inclinationDeg: Number(r.line2.substring(8, 16)),
  };
}

/**
 * The element set's epoch, ms since 1970, without a satrec. OMM's `EPOCH` is UTC without a
 * zone, to the microsecond; a TLE's is YYDDD.DDDDDDDD in line 1 columns 19-32, where years
 * from 57 are 1900s. NaN when unreadable.
 */
export function epochMsOf(r: GpRecord): number {
  if (r.kind === "omm") {
    // Date.parse is only specified for milliseconds.
    const iso = String(r.omm.EPOCH ?? "").replace(/(\.\d{3})\d+/, "$1");
    return Date.parse(/[Zz]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
  }
  const yy = Number(r.line1.substring(18, 20));
  const dayOfYear = Number(r.line1.substring(20, 32));
  return Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (dayOfYear - 1) * 86_400_000;
}

/**
 * Period in minutes from the Kozai mean motion, without a satrec. It differs from
 * the SGP4-recovered period by 0.96 s median, 4.1 s worst (live catalog), so do not
 * use it to place samples in time (see sgp4Worker).
 */
export function approximatePeriodMinutes(r: GpRecord): number {
  const { meanMotionRevPerDay } = classifyingElements(r);
  if (!Number.isFinite(meanMotionRevPerDay) || meanMotionRevPerDay <= 0) {
    return 0;
  }
  return MINUTES_PER_DAY / meanMotionRevPerDay;
}

/** km³/s², WGS-72 as SGP4 uses it. */
const MU_KM3_S2 = 398600.8;
/** km, WGS-72. */
const EARTH_RADIUS_KM = 6378.135;

/**
 * Mean altitude (GCAT's "h": semi-major axis less Earth's equatorial radius, km) and
 * inclination (°), from the Kozai mean motion without a satrec. Within a few km of the
 * SGP4-recovered axis, which the browser's orbit-shape chart, on a log scale, cannot show.
 */
export function orbitShapeOf(r: GpRecord): { altitudeKm: number; inclinationDeg: number } {
  const { meanMotionRevPerDay, inclinationDeg } = classifyingElements(r);
  const radPerSecond = (meanMotionRevPerDay * 2 * Math.PI) / 86_400;
  const semiMajorAxisKm = Math.cbrt(MU_KM3_S2 / (radPerSecond * radPerSecond));
  return { altitudeKm: semiMajorAxisKm - EARTH_RADIUS_KM, inclinationDeg };
}

/**
 * Not via a satrec: this runs for every record at parse time, and ~10,000
 * `sgp4init` calls would block the main thread. Eccentricity goes first because
 * a HEO can have an MEO-like period.
 */
export function orbitClassOf(r: GpRecord): OrbitClass {
  const { meanMotionRevPerDay, eccentricity } = classifyingElements(r);
  if (eccentricity > 0.25) {
    return "HEO";
  }
  const periodMin = MINUTES_PER_DAY / meanMotionRevPerDay;
  if (periodMin <= 128) {
    return "LEO";
  }
  // Geosynchronous is 1436 min; the band admits drifting and inclined GEO.
  if (periodMin >= 1400 && periodMin <= 1470) {
    return "GEO";
  }
  return "MEO";
}

/**
 * GCAT's kind code by GCAT's published bounds, where the elements reproduce it (ADR 0012): a
 * LEO's inclination band, agreeing with GCAT's codes for 99.99% of the catalog, and Molniya. A
 * GEO's kind follows GCAT's canonical orbit, which the elements match for 63% only.
 */
export function computedOrbitKindOf(r: GpRecord, orbitClass: OrbitClass): string | undefined {
  const { meanMotionRevPerDay, eccentricity, inclinationDeg } = classifyingElements(r);
  if (!Number.isFinite(inclinationDeg)) {
    return undefined;
  }
  if (orbitClass === "LEO") {
    return inclinationDeg < 25 ? "E" : inclinationDeg < 85 ? "I" : inclinationDeg < 95 ? "P" : inclinationDeg < 104 ? "S" : "R";
  }
  const periodMin = MINUTES_PER_DAY / meanMotionRevPerDay;
  // 11:30-12:30 h, 62-64°, e 0.50-0.77.
  if (orbitClass === "HEO" && periodMin >= 690 && periodMin <= 750 && inclinationDeg >= 62 && inclinationDeg <= 64 && eccentricity >= 0.5 && eccentricity <= 0.77) {
    return "M";
  }
  return undefined;
}

/**
 * Derived at load rather than served, so it cannot go stale against the element
 * set (docs/adr/0002-static-satellite-metadata.md).
 */
function cacheOrbitClass(records: GpRecord[]): GpRecord[] {
  for (const record of records) {
    record.metadata = { ...record.metadata, orbitClass: orbitClassOf(record) };
  }
  return records;
}

/** Never throws: malformed input is skipped with a warning. */
export function parseGpPayload(text: string): GpRecord[] {
  const trimmed = text.trimStart();
  const firstChar = trimmed[0];
  if (firstChar === "[" || firstChar === "{") {
    return cacheOrbitClass(parseJsonPayload(text));
  }
  // A missing group on an SPA-fallback host answers index.html with a 200.
  if (firstChar === "<") {
    console.warn("Skipping GP payload that looks like HTML (missing group?)");
    return [];
  }
  return cacheOrbitClass(parseTleText(text));
}

function parseJsonPayload(text: string): GpRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.warn("Failed to parse GP JSON payload", error);
    return [];
  }
  const array = Array.isArray(parsed) ? parsed : [parsed];
  const records: GpRecord[] = [];
  for (const item of array) {
    if (isWorkerTleRecord(item)) {
      const name = item.OBJECT_NAME?.trim() || satnumFromTleLine(item.TLE_LINE1);
      records.push({ kind: "tle", name, line1: item.TLE_LINE1, line2: item.TLE_LINE2, ...metadataOf(item) });
    } else if (typeof item === "object" && item !== null) {
      // Lift `metadata` out so `omm` stays a verbatim CCSDS element set (the info panel shows it).
      const { metadata: _lifted, ...omm } = item as Record<string, unknown>;
      records.push({ kind: "omm", omm: omm as OMMJsonObject, ...metadataOf(item) });
    } else {
      console.warn("Skipping unrecognized GP record", item);
    }
  }
  return records;
}

/** Omits the key when absent, rather than spreading an explicit undefined. */
function metadataOf(item: unknown): { metadata?: SatelliteMetadata } {
  const metadata = (item as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return {};
  }
  return { metadata: metadata as SatelliteMetadata };
}

/**
 * Near-duplicate of parseTleText in worker/scripts/generate-groups.mjs with the
 * opposite error policy (this one warns and skips, that one throws). Do not unify them.
 */
function parseTleText(text: string): GpRecord[] {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  const records: GpRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (line.startsWith("1 ")) {
      // Bare 2-line block.
      const line1 = line;
      const line2 = lines[i + 1] ?? "";
      if (line2.startsWith("2 ")) {
        records.push({ kind: "tle", name: satnumFromTleLine(line1), line1, line2 });
        i += 2;
      } else {
        console.warn(`Skipping malformed TLE block at line ${i}: line 2 missing or invalid`);
        i += 1;
      }
    } else {
      // Name line followed by two TLE lines.
      const line1 = lines[i + 1] ?? "";
      const line2 = lines[i + 2] ?? "";
      if (line1.startsWith("1 ") && line2.startsWith("2 ")) {
        records.push({ kind: "tle", name: stripNamePrefix(line.trim()), line1, line2 });
        i += 3;
      } else {
        console.warn(`Skipping malformed TLE block at line ${i}: expected name + 2 TLE lines`);
        i += 1;
      }
    }
  }
  return records;
}

export function recordName(r: GpRecord): string {
  if (r.kind === "omm") {
    return (r.omm.OBJECT_NAME ?? "").trim();
  }
  return r.name;
}

export function recordSatnum(r: GpRecord): string {
  if (r.kind === "omm") {
    return normalizeSatnum(String(r.omm.NORAD_CAT_ID ?? ""));
  }
  return normalizeSatnum(satnumFromTleLine(r.line1));
}

/** The only satrec creation point in the frontend. */
export function createSatrec(r: GpRecord): SatRec {
  if (r.kind === "omm") {
    return json2satrec(r.omm);
  }
  return twoline2satrec(r.line1, r.line2);
}

export function recordTleLines(r: GpRecord): string[] | undefined {
  if (r.kind === "tle") {
    return [r.name, r.line1, r.line2];
  }
  return undefined;
}
