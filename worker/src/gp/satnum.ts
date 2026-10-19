// The satellite-table join's key, shared by the GP records and the table parsers.

import type { GpRecord, OmmRecord } from "./types.ts";

/**
 * Normalized, so key 5 matches a NORAD_CAT_ID of 5, "5" or "00005". TleRecords are
 * read from columns 3-7 of line 1, because pseudo element sets in `extraRecords`
 * have no NORAD_CAT_ID. Alpha-5 ids ("E8493") never match a numeric table key.
 */
export function enrichmentSatnum(record: GpRecord): string {
  // `"TLE_LINE1" in record` cannot narrow: OmmRecord's index signature admits the key.
  const line1 = (record as { TLE_LINE1?: unknown }).TLE_LINE1;
  const raw = typeof line1 === "string" ? line1.substring(2, 7) : String((record as OmmRecord).NORAD_CAT_ID ?? "");
  return normalizeSatnumKey(raw);
}

/**
 * Both sides of the satellite-table join use this, so the SATCAT parser keys rows
 * exactly as enrichmentSatnum looks them up.
 */
export function normalizeSatnumKey(raw: string): string {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? String(parseInt(trimmed, 10)) : trimmed;
}
