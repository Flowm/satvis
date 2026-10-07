// SATCAT, a contributor to the satellite table (ADR 0006): launch, status and decay.
// The download and the stored file are upstream.ts's.

import { normalizeSatnumKey } from "./evaluate.ts";
import type { SatcatRows } from "./types.ts";
import type { UpstreamSpec } from "./upstream.ts";

/**
 * The full catalog (~70k objects, ~6.7 MB). Not records.php?GROUP=active: it is 4.5x
 * smaller but drops the rocket bodies, debris and just-decayed objects that last-30-days carries.
 */
export const SATCAT_URL = "https://celestrak.org/pub/satcat.csv";

/**
 * SATCAT column -> key in src/config/satelliteMetadata.ts. Left out on purpose:
 *   OWNER                              `country` is GCAT's, which names a country (ADR 0008)
 *   PERIOD/INCLINATION/APOGEE/PERIGEE  the element set gives them unrounded
 *   RCS                                2.9% coverage on the satellites we serve
 *   DATA_STATUS_CODE                   empty for all of them
 *   OBJECT_TYPE                        12,583 of 12,594 are PAY; revisit for a debris group
 *   OBJECT_NAME/OBJECT_ID              the GP record carries both
 */
const FIELDS: [string, string][] = [
  ["LAUNCH_DATE", "launchDate"],
  ["LAUNCH_SITE", "launchSite"],
  ["OPS_STATUS_CODE", "opsStatus"],
  ["ORBIT_TYPE", "orbitType"],
  ["ORBIT_CENTER", "orbitCenter"],
  ["DECAY_DATE", "decayDate"],
];

/** The metadata keys SATCAT owns; no other upstream table may write them (ADR 0008). */
export const SATCAT_KEYS: readonly string[] = FIELDS.map(([, key]) => key);

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
 * it is not stored and the stored file stands.
 */
export function parseSatcatCsv(body: string): SatcatRows {
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

  const rows: SatcatRows = {};
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

/** CelesTrak's whole catalog, for launch, status and decay. */
export const SATCAT: UpstreamSpec<SatcatRows> = {
  name: "satcat",
  url: SATCAT_URL,
  parse: parseSatcatCsv,
  timeoutMs: 60_000,
  // CelesTrak updates it once or twice a day; push-catalog checks daily.
  staleAfterMs: 2 * 24 * 3600_000,
};
