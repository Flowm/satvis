// GCAT, Jonathan McDowell's catalogue, a contributor to the satellite table (ADR 0008):
// what a satellite is (country, operator, maker, bus, mass, size, purpose). CC BY 4.0,
// "Data from J. McDowell, planet4589.org". The download and the stored files are upstream.ts's.

import { normalizeSatnumKey } from "./evaluate.ts";
import type { GcatOrgNames, GcatPayloadRows, GcatRow, GcatRows } from "./types.ts";
import type { UpstreamSpec } from "./upstream.ts";

/** ~19 MB, not served compressed. */
export const GCAT_CATALOG_URL = "https://planet4589.org/space/gcat/tsv/cat/satcat.tsv";
/** ~0.7 MB: every organisation, country and intergovernmental body a catalog code names. */
export const GCAT_ORGS_URL = "https://planet4589.org/space/gcat/tsv/tables/orgs.tsv";
/** ~5 MB: the payloads' purpose (Category) and owner type (Class), keyed by JCAT. */
export const GCAT_PAYLOADS_URL = "https://planet4589.org/space/gcat/tsv/cat/psatcat.tsv";

/** GCAT updates by hand, about weekly; push-catalog checks daily. */
const GCAT_STALE_AFTER_MS = 10 * 24 * 3600_000;

/**
 * Statuses that end an object's time in orbit: reentered, deorbited, landed, failed at
 * launch, suborbital, and reentered or landed while attached. A docked (`DK`) or
 * renamed (`N`) object is still up.
 */
const GONE_STATUSES = new Set(["R", "D", "L", "F", "S", "AR", "AS", "AL"]);

/** Catalog column -> key, for the free-text and code columns. */
const TEXT_FIELDS: [string, Exclude<keyof GcatRow, "jcat" | "estimated" | "massKg" | "lengthM" | "diameterM" | "spanM">][] = [
  ["State", "country"],
  ["Bus", "bus"],
  ["Manufacturer", "manufacturer"],
  ["Owner", "operator"],
  ["Shape", "shape"],
];

/** Value column, its `?` flag column, key; units as GCAT gives them, kg and m. */
const NUMBER_FIELDS: [string, string, "massKg" | "lengthM" | "diameterM" | "spanM"][] = [
  ["Mass", "MassFlag", "massKg"],
  ["Length", "LFlag", "lengthM"],
  ["Diameter", "DFlag", "diameterM"],
  ["Span", "SpanFlag", "spanM"],
];

/** Payload table column -> key; both travel as codes, labelled by src/config/gcatCodes.ts. */
const PAYLOAD_FIELDS: [string, "category" | "class"][] = [
  ["Category", "category"],
  ["Class", "class"],
];

/**
 * The metadata keys GCAT owns, from the same tables the parsers read, so a new column
 * cannot slip past the test that no other upstream table writes them (ADR 0008).
 */
export const GCAT_KEYS: readonly string[] = [...TEXT_FIELDS.map(([, key]) => key), ...NUMBER_FIELDS.map(([, , key]) => key), "estimated", ...PAYLOAD_FIELDS.map(([, key]) => key)];

/** Organisation types named by their short English name ("Germany", "ESA"): countries, territories, intergovernmental bodies. */
const STATE_TYPES = new Set(["CY", "CYP", "IGO"]);

/** GCAT writes "-" for an empty cell. `index` is a column parseTsv resolved, so present. */
function cell(fields: string[], index: number | undefined): string | undefined {
  const value = index === undefined ? undefined : fields[index]?.trim();
  return value === undefined || value === "" || value === "-" ? undefined : value;
}

/**
 * One flat copy per distinct value. V8 keeps a substring of 13 or more characters
 * (`Starlink V2MO`) as a slice of its source, so one such value would keep the whole
 * ~19 MB body alive: measured, 38 MB live after the parse, 17 MB with interning. The values
 * repeat (`US`, `Box + pan`), so a copy each costs little.
 */
function interner(): (value: string) => string {
  const seen = new Map<string, string>();
  return (value) => {
    let copy = seen.get(value);
    if (copy === undefined) {
      copy = JSON.parse(JSON.stringify(value)) as string;
      seen.set(copy, copy);
    }
    return copy;
  };
}

/**
 * Each line in turn, without splitting the whole body: the catalog is ~19 MB, and a GP
 * update holds it beside its ingest bundle within a Worker's 128 MB.
 */
function* lines(body: string): Generator<string> {
  let start = 0;
  while (start < body.length) {
    const end = body.indexOf("\n", start);
    const stop = end === -1 ? body.length : end;
    yield body.charCodeAt(stop - 1) === 13 ? body.slice(start, stop - 1) : body.slice(start, stop);
    start = stop + 1;
  }
}

/**
 * The header is the first line, `#`-prefixed; columns resolve by name, because GCAT
 * adds columns. Throws on a body that is not this table, so the caller keeps the
 * last-known-good snapshot.
 */
function parseTsv<K extends string>(body: string, required: readonly K[]): { index: Record<K, number>; rows: Generator<string[]> } {
  const iterator = lines(body);
  const first = iterator.next();
  if (first.done || !first.value.startsWith("#")) {
    throw new Error(`no header line (got ${JSON.stringify((first.value ?? "").slice(0, 120))})`);
  }
  const columns = first.value
    .slice(1)
    .split("\t")
    .map((name) => name.trim());
  const index = {} as Record<K, number>;
  for (const name of required) {
    index[name] = columns.indexOf(name);
    if (index[name] === -1) {
      throw new Error(`no ${name} column (header: ${JSON.stringify(first.value.slice(0, 120))})`);
    }
  }
  function* rows(): Generator<string[]> {
    let row = 1;
    for (const line of iterator) {
      row++;
      if (line === "" || line.startsWith("#")) {
        continue;
      }
      const fields = line.split("\t");
      if (fields.length !== columns.length) {
        throw new Error(`row ${row} has ${fields.length} fields, expected ${columns.length}`);
      }
      yield fields;
    }
  }
  return { index, rows: rows() };
}

/** Every catalog column the parser reads. */
const CATALOG_COLUMNS = ["JCAT", "Satcat", "Type", "Status", ...TEXT_FIELDS.map(([name]) => name), ...NUMBER_FIELDS.flatMap(([value, flag]) => [value, flag])];

/**
 * Only payloads still in orbit, with a NORAD number: of ~70k rows that leaves ~20k, and
 * loses 15 of the ~15,700 served objects GCAT knows (rocket bodies and debris in
 * last-30-days). `NNA` marks an object without a NORAD number.
 */
function keepsRow(fields: string[], index: Record<"Satcat" | "Type" | "Status", number>): boolean {
  const satnum = cell(fields, index.Satcat);
  // "AR IN": the second word says inside or outside, not whether it is still up.
  return satnum !== undefined && /^\d+$/.test(satnum) && (cell(fields, index.Type) ?? "").startsWith("P") && !GONE_STATUSES.has((cell(fields, index.Status) ?? "").split(" ")[0]!);
}

/** Keyed by normalized satnum; see keepsRow for which objects. */
export function parseGcatCatalog(body: string): GcatRows {
  const { index, rows: tsvRows } = parseTsv(body, CATALOG_COLUMNS);
  const intern = interner();
  const rows: GcatRows = {};
  for (const fields of tsvRows) {
    if (!keepsRow(fields, index)) {
      continue;
    }
    const satnum = cell(fields, index.Satcat)!;
    const row: GcatRow = { jcat: intern(cell(fields, index.JCAT) ?? "") };
    for (const [name, key] of TEXT_FIELDS) {
      const value = cell(fields, index[name]);
      if (value !== undefined) {
        // GCAT's free text is hand-typed: "Box +  2 pan".
        row[key] = intern(value.replace(/\s+/g, " "));
      }
    }
    const estimated: string[] = [];
    for (const [name, flag, key] of NUMBER_FIELDS) {
      const value = cell(fields, index[name]);
      if (value === undefined || !Number.isFinite(Number(value))) {
        continue;
      }
      row[key] = Number(value);
      if (cell(fields, index[flag]) === "?") {
        estimated.push(key);
      }
    }
    if (estimated.length > 0) {
      row.estimated = estimated;
    }
    rows[intern(normalizeSatnumKey(satnum))] = row;
  }
  if (Object.keys(rows).length === 0) {
    throw new Error("no records");
  }
  return rows;
}

/** Code -> display name: the short English name of a state ("Germany"), else the English name, else the name. */
export function parseGcatOrgs(body: string): GcatOrgNames {
  const { index, rows } = parseTsv(body, ["Code", "Type", "ShortEName", "EName", "Name"]);
  const intern = interner();
  const names: GcatOrgNames = {};
  for (const fields of rows) {
    const code = cell(fields, index.Code);
    if (code === undefined) {
      continue;
    }
    const isState = (cell(fields, index.Type) ?? "").split("/").some((type) => STATE_TYPES.has(type));
    const name = (isState ? cell(fields, index.ShortEName) : undefined) ?? cell(fields, index.EName) ?? cell(fields, index.Name);
    if (name !== undefined) {
      names[intern(code)] = intern(name);
    }
  }
  if (Object.keys(names).length === 0) {
    throw new Error("no records");
  }
  return names;
}

/**
 * JCAT -> purpose and owner type, as codes: `Category` ("IMG/TECH", "COM?") and `Class`
 * ("B", "BD"). Payloads without either are skipped.
 */
export function parseGcatPayloads(body: string): GcatPayloadRows {
  const { index, rows } = parseTsv(body, ["JCAT", ...PAYLOAD_FIELDS.map(([name]) => name)]);
  const intern = interner();
  const payloads: GcatPayloadRows = {};
  for (const fields of rows) {
    const jcat = cell(fields, index.JCAT);
    if (jcat === undefined) {
      continue;
    }
    const payload: GcatPayloadRows[string] = {};
    for (const [name, key] of PAYLOAD_FIELDS) {
      const value = cell(fields, index[name]);
      if (value !== undefined) {
        payload[key] = intern(value);
      }
    }
    if (Object.keys(payload).length > 0) {
      payloads[intern(jcat)] = payload;
    }
  }
  if (Object.keys(payloads).length === 0) {
    throw new Error("no records");
  }
  return payloads;
}

/**
 * The satellite table's GCAT bags: catalog rows with organisation and country codes
 * named, joined to the payload table by JCAT. A field may join several codes
 * (`KHRO/RKKE`, two makers). A code the organisations table lacks stays a code, as a
 * SATCAT code without a label does (ADR 0006). Each table may be missing.
 */
export function gcatBags(catalog: GcatRows | undefined, orgs: GcatOrgNames | undefined, payloads: GcatPayloadRows | undefined): Record<string, Record<string, unknown>> {
  const name = (codes: string): string =>
    codes
      .split("/")
      .map((code) => orgs?.[code] ?? code)
      .join(" / ");
  const bags: Record<string, Record<string, unknown>> = {};
  for (const [satnum, { jcat, ...row }] of Object.entries(catalog ?? {})) {
    const bag: Record<string, unknown> = { ...row, ...payloads?.[jcat] };
    for (const key of ["country", "manufacturer", "operator"] as const) {
      const codes = row[key];
      if (codes !== undefined) {
        bag[key] = name(codes);
      }
    }
    bags[satnum] = bag;
  }
  return bags;
}

/** The catalog: one row per object, the payloads still in orbit kept. */
export const GCAT_CATALOG: UpstreamSpec<GcatRows> = {
  name: "gcat",
  url: GCAT_CATALOG_URL,
  parse: parseGcatCatalog,
  // A personal server, sending ~19 MB uncompressed.
  timeoutMs: 120_000,
  staleAfterMs: GCAT_STALE_AFTER_MS,
};

/** The organisations table, which names the catalog's country, operator and maker codes. */
export const GCAT_ORGS: UpstreamSpec<GcatOrgNames> = {
  name: "gcatOrgs",
  url: GCAT_ORGS_URL,
  parse: parseGcatOrgs,
  timeoutMs: 60_000,
  staleAfterMs: GCAT_STALE_AFTER_MS,
};

/** The payload catalog, for each payload's purpose and owner type. */
export const GCAT_PAYLOADS: UpstreamSpec<GcatPayloadRows> = {
  name: "gcatPayloads",
  url: GCAT_PAYLOADS_URL,
  parse: parseGcatPayloads,
  timeoutMs: 60_000,
  staleAfterMs: GCAT_STALE_AFTER_MS,
};
