import { JulianDate } from "@cesium/engine";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import { gcatCategoryLabel, gcatClassLabel } from "../../config/gcatCodes";
import type { OrbitClass } from "../../config/orbitClass";
import { satcatLabel, SATCAT_LAUNCH_SITE, SATCAT_OPS_STATUS, SATCAT_ORBIT_TYPE } from "../../config/satcatCodes";
import { swathExtentsOf, type SatelliteMetadata } from "../../config/satelliteMetadata";
import type Orbit from "../Orbit";
import { recordTleLines } from "./gp";
import { derivedOrbitRows, orbitRegimeLabel } from "./orbitFacts";

dayjs.extend(utc);

/** `epochMs` is the element set's epoch in Unix milliseconds; `epoch` is its label. */
export type ElementsInfo = { kind: "tle"; epoch: string; epochMs: number; lines: string } | { kind: "omm"; epoch: string; epochMs: number; rows: [string, string][] };

/** Julian date of the Unix epoch. */
const JD_UNIX_EPOCH = 2440587.5;

/**
 * How far the simulation time may be from the element epoch before the panel warns. After
 * two weeks most satellites are a few km off, a low one can be 1,000 km off. Live element
 * sets are rarely over 2 days old, so only time travel triggers it.
 */
export const STALE_ELEMENTS_DAYS = 10;

/** What the info panel shows of a satellite: a header, and the facts as rows. */
export interface SatelliteInfo {
  /** The dot's colour. */
  orbitClass: OrbitClass;
  /** Under the name: the orbit, then the country and the status where known. */
  chips: string[];
  rows: [string, string][];
}

/**
 * Derived rows first, then served rows only for fields the record carries: the
 * renderer's fallback values are defaults, not data about the satellite.
 * `orbitClass` comes from the caller (`CatalogEntry.orbitClass`), not the bag.
 */
export function getSatelliteInfo(orbit: Orbit, orbitClass: OrbitClass, metadata: SatelliteMetadata): SatelliteInfo {
  const regime = orbitRegimeLabel(orbitClass, orbit);
  const status = metadata.opsStatus === undefined ? undefined : satcatLabel(SATCAT_OPS_STATUS, metadata.opsStatus);
  const chips = [regime, metadata.country, status].filter((chip): chip is string => chip !== undefined);
  return { orbitClass, chips, rows: satelliteRows(orbit, regime, metadata, status) };
}

function satelliteRows(orbit: Orbit, regime: string, metadata: SatelliteMetadata, status: string | undefined): [string, string][] {
  const rows: [string, string][] = [["Orbit", regime], ...derivedOrbitRows(orbit)];

  const { coneFovDeg, missionType, country, operator, category, class: ownerClass, manufacturer, bus, massKg, launchDate, launchSite, orbitType, decayDate } = metadata;
  const extents = swathExtentsOf(metadata);
  if (extents !== undefined) {
    const { starboardKm, portKm } = extents;
    const total = starboardKm + portKm;
    rows.push(["Swath", starboardKm === portKm ? `${total} km` : `${total} km (${starboardKm} stbd / ${portKm} port)`]);
  }
  if (coneFovDeg !== undefined) {
    rows.push(["Sensor FOV", `${coneFovDeg}°`]);
  }
  if (missionType !== undefined) {
    rows.push(["Mission", missionType]);
  }
  if (country !== undefined) {
    rows.push(["Country", country]);
  }
  if (operator !== undefined) {
    rows.push(["Operator", operator]);
  }
  if (category !== undefined) {
    rows.push(["Purpose", gcatCategoryLabel(category)]);
  }
  if (ownerClass !== undefined) {
    rows.push(["Class", gcatClassLabel(ownerClass)]);
  }
  if (manufacturer !== undefined) {
    rows.push(["Manufacturer", manufacturer]);
  }
  if (bus !== undefined) {
    rows.push(["Bus", bus]);
  }
  if (massKg !== undefined) {
    rows.push(["Mass", `${approximate(metadata, "massKg", massKg.toLocaleString("en-US"))} kg`]);
  }
  const size = sizeOf(metadata);
  if (size !== undefined) {
    rows.push(["Size", size]);
  }
  if (launchDate !== undefined) {
    rows.push(["Launched", launchSite === undefined ? launchDate : `${launchDate} · ${satcatLabel(SATCAT_LAUNCH_SITE, launchSite)}`]);
  }
  if (status !== undefined) {
    rows.push(["Status", status]);
  }
  // Nearly every served satellite is "ORB", so only the exceptions get a row.
  if (orbitType !== undefined && orbitType !== "ORB") {
    rows.push(["Orbit type", satcatLabel(SATCAT_ORBIT_TYPE, orbitType)]);
  }
  if (decayDate !== undefined) {
    rows.push(["Decayed", decayDate]);
  }
  return rows;
}

/** GCAT flags most sizes and some masses as estimates (`estimated`); "~" says so. */
function approximate(metadata: SatelliteMetadata, key: keyof SatelliteMetadata, text: string): string {
  return metadata.estimated?.includes(key) ? `~${text}` : text;
}

/** "12.6 × 4.2 m, span 23.9 m": the body's two dimensions as GCAT gives them, then the span with arrays and booms. */
function sizeOf(metadata: SatelliteMetadata): string | undefined {
  const body = (["lengthM", "diameterM"] as const).flatMap((key) => (metadata[key] === undefined ? [] : [approximate(metadata, key, String(metadata[key]))]));
  const parts = body.length === 0 ? [] : [`${body.join(" × ")} m`];
  if (metadata.spanM !== undefined) {
    parts.push(`span ${approximate(metadata, "spanM", String(metadata.spanM))} m`);
  }
  return parts.length === 0 ? undefined : parts.join(", ");
}

export function getElementsInfo(orbit: Orbit): ElementsInfo {
  const epoch = formatEpoch(orbit.julianDate);
  const epochMs = (orbit.julianDate - JD_UNIX_EPOCH) * 86_400_000;
  if (orbit.record.kind === "tle") {
    const tle = orbit.tle ?? recordTleLines(orbit.record)!;
    return { kind: "tle", epoch, epochMs, lines: tle.slice(1, 3).join("\n") };
  }
  const { omm } = orbit.record;
  const rows: [string, unknown][] = [
    ["OBJECT_ID", omm.OBJECT_ID],
    ["NORAD_CAT_ID", omm.NORAD_CAT_ID],
    ["INCLINATION", omm.INCLINATION],
    ["RA_OF_ASC_NODE", omm.RA_OF_ASC_NODE],
    ["ECCENTRICITY", omm.ECCENTRICITY],
    ["ARG_OF_PERICENTER", omm.ARG_OF_PERICENTER],
    ["MEAN_ANOMALY", omm.MEAN_ANOMALY],
    ["MEAN_MOTION", omm.MEAN_MOTION],
    ["BSTAR", omm.BSTAR],
  ];
  return {
    kind: "omm",
    epoch,
    epochMs,
    rows: rows.filter(([, value]) => value !== undefined && value !== null).map(([label, value]) => [label, String(value)]),
  };
}

/**
 * The notice text, or undefined while the simulation time is within `STALE_ELEMENTS_DAYS` of
 * the epoch. Both directions count: propagating backwards is no more accurate.
 */
export function staleElementsNotice(epochMs: number, timeMs: number): string | undefined {
  const offsetDays = (timeMs - epochMs) / 86_400_000;
  if (Math.abs(offsetDays) <= STALE_ELEMENTS_DAYS) {
    return undefined;
  }
  const days = Math.round(Math.abs(offsetDays));
  return `Position may be inaccurate, clock ${days} days ${offsetDays > 0 ? "after" : "before"} element epoch`;
}

export function formatEpoch(julianDate: number): string {
  const julianDayNumber = Math.floor(julianDate);
  const secondsOfDay = (julianDate - julianDayNumber) * 60 * 60 * 24;
  const epochDate = new JulianDate(julianDayNumber, secondsOfDay);
  return dayjs.utc(epochDate as unknown as Date).format("YYYY-MM-DD HH:mm:ss");
}
