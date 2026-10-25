// Custom satellites: element sets a visitor pastes into the catalog sheet, kept in the browser
// rather than the url. Cesium-free for node-env vitest.

import { sgp4 } from "satellite.js";

import type { CatalogEntry } from "./SatelliteCatalog";
import { createSatrec, type GpRecord, parseGpPayload, recordName, recordSatnum } from "./util/gp";

/** The tag every custom satellite carries, and the group the catalog lists them under. */
export const CUSTOM_TAG = "Custom";

/** Keeps a custom satellite's catalog key apart from a group entry of its name and NORAD id. */
export const CUSTOM_KEY_PREFIX = "custom|";

/** Whether the entry is a custom satellite, by its key: a group may carry a tag of any name. */
export function isCustom(entry: CatalogEntry): boolean {
  return entry.key.startsWith(CUSTOM_KEY_PREFIX);
}

/** What a paste parses to. */
export interface CustomParse {
  /** The usable element sets. */
  records: GpRecord[];
  /** Why the rest were dropped, one line each. */
  problems: string[];
}

/** OMM fields SGP4 cannot start without. */
const REQUIRED_OMM_FIELDS = ["NORAD_CAT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY"] as const;
/** The drag terms, which a hand-written OMM often leaves out; zero is a drag-free orbit. */
const DRAG_OMM_FIELDS = ["BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT"] as const;

/**
 * TLE or 3LE text, or an OMM as JSON (CelesTrak's or Space-Track's), CSV with a header row, XML or
 * KVN. `isTaken` names a satellite of the catalog's that a custom one may not shadow: activation
 * goes by name.
 */
export function parseCustomElements(text: string, isTaken: (name: string) => boolean = () => false): CustomParse {
  const problems: string[] = [];
  const parsed = parseAnyFormat(text.trim(), (message) => problems.push(message));
  if (parsed.length === 0 && text.trim() !== "") {
    problems.push("No element set found: paste a TLE, or an OMM as JSON, CSV, XML or KVN");
  }
  const records: GpRecord[] = [];
  const names = new Set<string>();
  for (const record of parsed) {
    withDragDefaults(record);
    const name = recordName(record);
    const problem = problemOf(record) ?? (names.has(name) ? "is listed twice" : isTaken(name) ? "is the name of a catalog satellite; rename it" : undefined);
    if (problem) {
      problems.push(`${name || `NORAD ${recordSatnum(record) || "?"}`} ${problem}`);
      continue;
    }
    names.add(name);
    records.push(record);
  }
  return { records, problems };
}

/** A KVN line no TLE or CSV has; a KVN may open with COMMENT lines, which have no `=`. */
const KVN_LINE = /^\s*(CCSDS_OMM_VERS|NORAD_CAT_ID|MEAN_MOTION)\s*=/m;

/** Every OMM format goes through the JSON parser, so a record is the same whichever was pasted. */
function parseAnyFormat(text: string, warn: (message: string) => void): GpRecord[] {
  if (text === "") {
    return [];
  }
  const omms = text.startsWith("<") ? ommsFromXml(text) : KVN_LINE.test(text) ? ommsFromKvn(text) : ommsFromCsv(text);
  return parseGpPayload(omms === undefined ? text : JSON.stringify(omms), warn);
}

/** Zero for each drag term an OMM leaves out or empty. */
function withDragDefaults(record: GpRecord): void {
  if (record.kind === "omm") {
    const omm = record.omm as unknown as Record<string, unknown>;
    for (const field of DRAG_OMM_FIELDS) {
      if (omm[field] === undefined || omm[field] === "") {
        omm[field] = 0;
      }
    }
  }
}

/** Why SGP4 cannot use the record, or undefined when it can. */
function problemOf(record: GpRecord): string | undefined {
  if (recordName(record) === "") {
    return "has no name";
  }
  if (record.kind === "omm") {
    const omm = record.omm as unknown as Record<string, unknown>;
    const missing = REQUIRED_OMM_FIELDS.filter((field) => omm[field] === undefined || omm[field] === "");
    if (missing.length > 0) {
      return `lacks ${missing.join(", ")}`;
    }
  }
  try {
    const satrec = createSatrec(record);
    const position = satrec.error === 0 ? sgp4(satrec, 0)?.position : undefined;
    if (position && [position.x, position.y, position.z].every(Number.isFinite)) {
      return undefined;
    }
  } catch {
    // Falls through to the problem.
  }
  return "does not propagate: check its numbers";
}

/** CSV with a header row of OMM field names, as CelesTrak serves it; undefined when the text is no such CSV. */
function ommsFromCsv(text: string): Record<string, string>[] | undefined {
  const [header, ...rows] = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (header === undefined || !/(^|,)\s*"?NORAD_CAT_ID"?\s*(,|$)/.test(header)) {
    return undefined;
  }
  const fields = csvCells(header);
  return rows.map((row) => Object.fromEntries(csvCells(row).map((cell, index) => [fields[index] ?? "", cell])));
}

/** One CSV line's cells; a quoted cell may hold commas, and "" is a quote. */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * CCSDS OMM XML, one `<segment>` per satellite. Read by pattern rather than a DOM parser, which
 * node-env vitest lacks: every field OMM needs is a leaf element of plain text, its unit an attribute.
 */
function ommsFromXml(text: string): Record<string, string>[] {
  const segments = text.split(/<segment\b[^>]*>/).slice(1);
  return (segments.length > 0 ? segments : [text]).map((segment) =>
    Object.fromEntries([...segment.matchAll(/<([A-Z_]+)(?:\s[^>]*)?>([^<]*)<\/\1>/g)].map(([, field, value]) => [field, decodeXml(value ?? "").trim()])),
  );
}

/** XML's five predefined entities. */
const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The predefined entities and numeric references. */
function decodeXml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** KVN fields whose value may end in brackets of its own, as "STARLINK-1234 [DTC]" does. */
const KVN_NAME_FIELDS = new Set(["OBJECT_NAME", "OBJECT_ID"]);

/**
 * CCSDS OMM KVN, `KEY = value` lines, a new satellite at each `CCSDS_OMM_VERS`. A unit in brackets
 * after a number is dropped.
 */
function ommsFromKvn(text: string): Record<string, string>[] {
  const omms: Record<string, string>[] = [];
  let current: Record<string, string> | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const [, field = "", raw = ""] = match;
    const value = KVN_NAME_FIELDS.has(field) ? raw : raw.replace(/\s*\[[^\]]*\]$/, "");
    if (field === "CCSDS_OMM_VERS" || current === undefined || field in current) {
      current = {};
      omms.push(current);
    }
    current[field] = value;
  }
  return omms;
}

/** The records as a GP payload, the worker's JSON, which parseGpPayload reads back. */
export function serializeCustomRecords(records: readonly GpRecord[]): string {
  return JSON.stringify(records.map((record) => (record.kind === "tle" ? { OBJECT_NAME: record.name, TLE_LINE1: record.line1, TLE_LINE2: record.line2 } : record.omm)));
}
