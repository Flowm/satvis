// The upstream half of the satellite table (see ADR 0006). Not a group source: it
// selects nothing, so its failure degrades enrichment without failing a group.

import type { FetchImpl } from "./evaluate.ts";
import { normalizeSatnumKey } from "./evaluate.ts";
import type { SatcatSnapshot } from "./types.ts";

/**
 * The full catalog (~70k objects, ~6.7 MB). Not records.php?GROUP=active: it is 4.5x
 * smaller but drops the rocket bodies, debris and just-decayed objects that last-30-days carries.
 */
export const SATCAT_URL = "https://celestrak.org/pub/satcat.csv";

const USER_AGENT = "satvis.space (https://github.com/Flowm/satvis)";
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * SATCAT column -> key in src/config/satelliteMetadata.ts. Left out on purpose:
 *   PERIOD/INCLINATION/APOGEE/PERIGEE  the element set gives them unrounded
 *   RCS                                2.9% coverage on the satellites we serve
 *   DATA_STATUS_CODE                   empty for all of them
 *   OBJECT_TYPE                        12,583 of 12,594 are PAY; revisit for a debris group
 *   OBJECT_NAME/OBJECT_ID              the GP record carries both
 */
const FIELDS: [string, string][] = [
  ["OWNER", "owner"],
  ["LAUNCH_DATE", "launchDate"],
  ["LAUNCH_SITE", "launchSite"],
  ["OPS_STATUS_CODE", "opsStatus"],
  ["ORBIT_TYPE", "orbitType"],
  ["ORBIT_CENTER", "orbitCenter"],
  ["DECAY_DATE", "decayDate"],
];

const SATNUM_COLUMN = "NORAD_CAT_ID";

/**
 * RFC 4180 quoting, but no quoted newlines: SATCAT has none, and the column-count
 * check in parseSatcatCsv would reject one.
 */
function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) {
    return line.split(",");
  }
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Keyed by normalized satnum. Columns resolve by header name, because CelesTrak
 * adds columns. Empty values are dropped. Throws on a body that is not SATCAT, so
 * the caller keeps the last-known-good snapshot.
 */
export function parseSatcatCsv(body: string): SatcatSnapshot["rows"] {
  // CelesTrak serves CRLF; a stray \r on the last field would blank ORBIT_TYPE.
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const header = lines[0];
  if (header === undefined || header.trim() === "") {
    throw new Error("empty body");
  }
  const columns = splitCsvLine(header).map((name) => name.trim());
  const satnumIndex = columns.indexOf(SATNUM_COLUMN);
  if (satnumIndex === -1) {
    throw new Error(`no ${SATNUM_COLUMN} column (header: ${JSON.stringify(header.slice(0, 120))})`);
  }
  const wanted = FIELDS.map(([column, key]) => [columns.indexOf(column), key] as const).filter(([index]) => index !== -1);

  const rows: SatcatSnapshot["rows"] = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") {
      continue;
    }
    const fields = splitCsvLine(line);
    if (fields.length !== columns.length) {
      throw new Error(`row ${i} has ${fields.length} fields, expected ${columns.length}`);
    }
    const satnum = normalizeSatnumKey(fields[satnumIndex]!);
    if (satnum === "") {
      continue;
    }
    const bag: Record<string, string> = {};
    for (const [index, key] of wanted) {
      const value = fields[index]!.trim();
      if (value !== "") {
        bag[key] = value;
      }
    }
    rows[satnum] = bag;
  }

  if (Object.keys(rows).length === 0) {
    throw new Error("no records");
  }
  return rows;
}

/** Exactly one of `rows`, `notModified` and `error` is set. */
export interface SatcatFetch {
  status?: number;
  ms: number;
  bytes?: number;
  rows?: SatcatSnapshot["rows"];
  validator?: string;
  notModified?: boolean;
  error?: string;
}

/**
 * Never throws. CelesTrak asks for one download per update, and SATCAT updates once
 * or twice a day against a 6 h refresh, so `validator` (the last ETag) makes the usual case a 304.
 */
export async function fetchSatcat(fetchImpl: FetchImpl, validator?: string): Promise<SatcatFetch> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (validator !== undefined) {
    headers["If-None-Match"] = validator;
  }
  try {
    const res = await fetchImpl(SATCAT_URL, { headers, signal: controller.signal });
    const ms = Date.now() - started;
    if (res.status === 304) {
      return { status: 304, ms, notModified: true };
    }
    if (res.status !== 200) {
      return { status: res.status, ms, error: `HTTP ${res.status}` };
    }
    const body = await res.text();
    try {
      return { status: 200, ms, bytes: body.length, rows: parseSatcatCsv(body), validator: res.headers?.get("ETag") ?? undefined };
    } catch (parseErr) {
      return { status: 200, ms, bytes: body.length, error: parseErr instanceof Error ? parseErr.message : String(parseErr) };
    }
  } catch (err) {
    return { ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
