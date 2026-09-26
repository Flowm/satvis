// Pure, runtime-agnostic group evaluator. NO Cloudflare APIs here so it can be
// unit-tested and reused by the static generator via node type stripping.

import type { GpRecord, GroupDefinition, GroupsIndex, GroupStatus, OmmRecord, SatelliteEntry, SatelliteSpec, SourceSpec } from "./types.ts";

const CELESTRAK_BASE = "https://celestrak.org/NORAD/elements/";
const USER_AGENT = "satvis.space (https://github.com/Flowm/satvis)";
// CelesTrak asks clients to space out requests; keep sources sequential and
// gentle.
const REQUEST_SPACING_MS = 250;
// Abort a single source fetch that stalls, so one slow/hanging upstream cannot
// block the whole sequential refresh (which would silently trip the cron / the
// 120s /__scheduled limit and leave no clue which source hung). 30s is generous
// for CelesTrak's largest groups over a healthy link yet clearly flags a stall.
const REQUEST_TIMEOUT_MS = 30_000;

// A stable, dedupable key for a source spec.
export function sourceKey(spec: SourceSpec): string {
  if ("celestrak" in spec) {
    return `celestrak:${spec.celestrak}`;
  }
  if ("celestrakSup" in spec) {
    return `celestrakSup:${spec.celestrakSup}`;
  }
  return `url:${spec.url}`;
}

export function sourceUrl(spec: SourceSpec): string {
  if ("celestrak" in spec) {
    return `${CELESTRAK_BASE}gp.php?GROUP=${encodeURIComponent(spec.celestrak)}&FORMAT=JSON`;
  }
  if ("celestrakSup" in spec) {
    return `${CELESTRAK_BASE}supplemental/sup-gp.php?FILE=${encodeURIComponent(spec.celestrakSup)}&FORMAT=JSON`;
  }
  return spec.url;
}

// Deduped by sourceKey, so two groups naming one source fetch it once.
export function collectSources(defs: GroupDefinition[]): SourceSpec[] {
  const seen = new Map<string, SourceSpec>();
  for (const def of defs) {
    for (const spec of def.sources ?? []) {
      const key = sourceKey(spec);
      if (!seen.has(key)) {
        seen.set(key, spec);
      }
    }
  }
  return [...seen.values()];
}

// Result of fetching every collected source. On failure a source maps to an
// Error rather than throwing, so a single bad upstream only breaks the groups
// that depend on it.
export type RecordsBySource = Map<string, OmmRecord[] | Error>;

export type FetchImpl = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  // Optional so a replayed bundle (bundleFetch) need only supply what it kept.
  // Read by the SATCAT fetch for the ETag it stores as its next conditional-request
  // validator; the GP sources ignore it.
  headers?: { get: (name: string) => string | null };
  text: () => Promise<string>;
}>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Hard validation: CelesTrak serves HTML error pages with HTTP 200, so we must
// check the body shape, not just the status code.
function parseOmmArray(status: number, body: string): OmmRecord[] {
  if (status !== 200) {
    throw new Error(`HTTP ${status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`response is not JSON (starts with ${JSON.stringify(body.slice(0, 32))})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("response is not a JSON array");
  }
  if (parsed.length === 0) {
    throw new Error("response array is empty");
  }
  const first = parsed[0] as Record<string, unknown>;
  if (first === null || typeof first !== "object" || !("NORAD_CAT_ID" in first)) {
    throw new Error("first element is missing NORAD_CAT_ID");
  }
  return parsed as OmmRecord[];
}

// Outcome of fetching one source. Always resolves (never throws) so callers can
// log and aggregate uniformly: `records` is set on success; otherwise `error`
// holds the reason, with `status` / `bytes` / `bodySample` kept whenever we got
// far enough to have them (they distinguish a bad body from a dead connection).
export interface SourceFetch {
  key: string;
  url: string;
  // Wall-clock duration of this fetch in ms.
  ms: number;
  status?: number;
  bytes?: number;
  records?: OmmRecord[];
  error?: string;
  bodySample?: string;
}

// Fetch and validate a single source, bounded by REQUEST_TIMEOUT_MS. The abort
// timer is always cleared (finally) so no stray timer outlives the call. Never
// throws — every failure mode is captured in the returned SourceFetch.
async function fetchSource(spec: SourceSpec, fetchImpl: FetchImpl): Promise<SourceFetch> {
  const key = sourceKey(spec);
  const url = sourceUrl(spec);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
    const body = await res.text();
    const ms = Date.now() - started;
    try {
      return { key, url, ms, status: res.status, bytes: body.length, records: parseOmmArray(res.status, body) };
    } catch (parseErr) {
      // Reached the origin but the body was not valid OMM (HTTP error page, HTML
      // challenge, empty array, ...). Keep the status and a short body sample so
      // the failure is diagnosable from the logs / debug endpoint alone.
      return { key, url, ms, status: res.status, bytes: body.length, error: parseErr instanceof Error ? parseErr.message : String(parseErr), bodySample: body.slice(0, 120) };
    }
  } catch (err) {
    // Never reached the origin: DNS/TLS/connection failure, or our abort timer
    // firing (HTTP 522-class stalls and hangs land here).
    return { key, url, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch every collected source sequentially, spaced ~250 ms apart. Never throws.
// Logs one line before each fetch (so a stall's culprit is the last line
// printed) and one after with the outcome, timing and size. Returns the rich
// per-source results; derive the evaluator input with toRecordsBySource() and a
// serializable report with toProbe().
export async function fetchSources(defs: GroupDefinition[], fetchImpl: FetchImpl): Promise<SourceFetch[]> {
  const specs = collectSources(defs);
  const results: SourceFetch[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    if (i > 0) {
      // Intentionally sequential: sources are fetched one at a time, spaced
      // REQUEST_SPACING_MS apart, to avoid hammering the origin. Cannot be
      // parallelized with Promise.all.
      // eslint-disable-next-line no-await-in-loop
      await delay(REQUEST_SPACING_MS);
    }
    const label = `[${i + 1}/${specs.length}]`;
    console.log(`gp fetch ${label} ${sourceKey(spec)}: GET ${sourceUrl(spec)}`);
    // eslint-disable-next-line no-await-in-loop -- sequential, rate-limited fetch (see above)
    const r = await fetchSource(spec, fetchImpl);
    if (r.records !== undefined) {
      console.log(`gp fetch ${label} ${r.key}: OK HTTP ${r.status}, ${r.records.length} records, ${r.bytes} bytes, ${r.ms}ms`);
    } else {
      // r.error already carries the HTTP status for status failures ("HTTP 522")
      // and a description for bad bodies; the sample shows what came back.
      const sample = r.bodySample ? ` body=${JSON.stringify(r.bodySample.replace(/\s+/g, " ").trim())}` : "";
      console.warn(`gp fetch ${label} ${r.key}: FAILED after ${r.ms}ms — ${r.error}${sample}`);
    }
    results.push(r);
  }
  return results;
}

// Reduce raw per-source fetches to the map the evaluator consumes: the records
// on success, an Error carrying the failure message otherwise.
export function toRecordsBySource(fetched: SourceFetch[]): RecordsBySource {
  const map: RecordsBySource = new Map();
  for (const r of fetched) {
    map.set(r.key, r.records ?? new Error(r.error ?? "fetch failed"));
  }
  return map;
}

// A single source's fetch diagnostics, safe to serialize to JSON (the record
// array is reduced to a count + sample name). Surfaced by the /api/refresh
// report so a caller sees exactly what each upstream returned — which matters
// because failures like Cloudflare 522s only reproduce from the Worker's egress.
export interface SourceProbe {
  key: string;
  url: string;
  ok: boolean;
  ms: number;
  status?: number;
  bytes?: number;
  records?: number;
  sample?: string;
  error?: string;
  bodySample?: string;
}

export function toProbe(r: SourceFetch): SourceProbe {
  return {
    key: r.key,
    url: r.url,
    ok: r.records !== undefined,
    ms: r.ms,
    status: r.status,
    bytes: r.bytes,
    records: r.records?.length,
    sample: r.records?.[0]?.OBJECT_NAME,
    error: r.error,
    bodySample: r.bodySample,
  };
}

function recordName(record: GpRecord): string {
  return record.OBJECT_NAME ?? "";
}

// The satnum a `select` / `satellites` row matches against: the raw NORAD_CAT_ID
// as a string, OMM records only.
//
// Deliberately NOT the same as enrichmentSatnum below, which normalizes and also
// reads TLE records. Selection semantics are frozen — widening this to normalize,
// or to reach pseudo TLE extras, would silently change which records land in which
// group. Enrichment has no such constraint and wants both. Same reasoning as the
// deliberate parseTleText near-duplicate between this package and the frontend: do
// not unify them.
function recordSatnum(record: GpRecord): string | undefined {
  const id = (record as OmmRecord).NORAD_CAT_ID;
  return id === undefined || id === null ? undefined : String(id);
}

// A `select` criterion compiled once per group: id and name lookups are Sets and
// the pattern is a single compiled RegExp, so testing a record is O(1) work and
// nothing is rebuilt inside the record loop. `undefined` when the group has no
// `select` at all.
interface CompiledSelect {
  noradIds: Set<string>;
  names: Set<string>;
  pattern: RegExp | undefined;
}

function compileSelect(select: GroupDefinition["select"]): CompiledSelect | undefined {
  if (!select) {
    return undefined;
  }
  return {
    noradIds: new Set((select.noradIds ?? []).map((id) => String(id))),
    names: new Set(select.names ?? []),
    pattern: select.namePattern ? new RegExp(select.namePattern) : undefined,
  };
}

// The `select` criteria are OR'd together, exactly as the original per-record
// checks were: id set, then name set, then pattern.
function selectMatches(record: OmmRecord, select: CompiledSelect | undefined): boolean {
  if (!select) {
    return false;
  }
  if (select.noradIds.size > 0) {
    const satnum = recordSatnum(record);
    if (satnum !== undefined && select.noradIds.has(satnum)) {
      return true;
    }
  }
  const name = recordName(record);
  if (select.names.has(name)) {
    return true;
  }
  return select.pattern !== undefined && select.pattern.test(name);
}

// The `satellites` rows compiled once per group into lookup maps. A row matches
// a record by noradId (when present) or, failing that, by exact upstreamName; a
// row with neither is invalid (the generator rejects it, and we ignore it
// defensively by never indexing it). Each map keys the matcher (string satnum or
// upstreamName) to the ascending list of row indices declaring it, so a record
// looks up its matching rows instead of scanning every row.
interface CompiledRows {
  // satnum -> indices of rows that select by that noradId.
  bySatnum: Map<string, number[]>;
  // upstreamName -> indices of rows that select by name (rows without a noradId).
  byName: Map<string, number[]>;
}

// Append a row index to a matcher map, creating the bucket on first use. Buckets
// stay in ascending index order because compileRows appends by increasing r.
function indexRow(map: Map<string, number[]>, key: string, index: number): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(index);
  } else {
    map.set(key, [index]);
  }
}

function compileRows(rows: SatelliteSpec[]): CompiledRows {
  const bySatnum = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.noradId !== undefined) {
      indexRow(bySatnum, String(row.noradId), r);
    } else if (row.upstreamName !== undefined) {
      indexRow(byName, row.upstreamName, r);
    }
  }
  return { bySatnum, byName };
}

// The ascending row indices matching a record, merging satnum-matched and
// name-matched rows so row-order precedence (lowest index wins the rename) is
// preserved. Both source lists are already ascending; each record touches at
// most one satnum key and one name key, so the union is small — a plain sort
// keeps the merge obviously correct.
function matchingRowIndices(record: OmmRecord, compiled: CompiledRows): number[] {
  const satnum = recordSatnum(record);
  const bySatnum = satnum !== undefined ? compiled.bySatnum.get(satnum) : undefined;
  const byName = compiled.byName.get(recordName(record));
  if (!bySatnum) {
    return byName ?? [];
  }
  if (!byName) {
    return bySatnum;
  }
  return [...bySatnum, ...byName].toSorted((a, b) => a - b);
}

// Result of selecting/renaming a group's own source records: the surviving
// records (with row-level renames already applied) plus any validation
// warnings the rows produced.
interface SelectResult {
  records: OmmRecord[];
  warnings: string[];
}

// Select source records via the OR-union of `satellites` rows and `select`,
// apply per-row `name` renames (precedence over the group `rename` map), then
// the group `rename` map to whatever a row did not rename. Emits warnings for
// id/name mismatches and rows whose id matched no record.
function applySelectAndRename(records: OmmRecord[], def: GroupDefinition): SelectResult {
  const rows = def.satellites ?? [];
  const warnings: string[] = [];
  const matchedByRow = rows.map(() => false);
  const out: OmmRecord[] = [];
  // Precompile the per-group matchers once, before the record loop, so nothing
  // (regex, id/name sets, row lookup maps) is rebuilt per record.
  const compiledRows = compileRows(rows);
  const compiledSelect = compileSelect(def.select);
  // With neither `satellites` rows nor a `select`, every source record passes
  // through (subject only to the group `rename` map) — the original semantics.
  const passAll = rows.length === 0 && !def.select;

  for (const record of records) {
    // Rows matching this record, already in ascending row order so the
    // row-order precedence below (first `name` wins) matches the old per-row
    // scan.
    const indices = matchingRowIndices(record, compiledRows);
    let matchedRow = false;
    let rowName: string | undefined;
    for (const r of indices) {
      const row = rows[r]!;
      matchedByRow[r] = true;
      if (row.noradId !== undefined && row.upstreamName !== undefined && recordName(record) !== row.upstreamName) {
        warnings.push(`noradId ${row.noradId}: expected OBJECT_NAME ${JSON.stringify(row.upstreamName)}, got ${JSON.stringify(recordName(record))}`);
      }
      // First matching row with a `name` wins the rename; keep scanning only to
      // mark later rows as matched (harmless, but rare — usually one row/record).
      if (rowName === undefined && row.name !== undefined) {
        rowName = row.name;
      }
      matchedRow = true;
    }
    if (matchedRow) {
      // A row with a `name` takes absolute precedence (the group `rename` map is
      // not consulted). A row without a `name` still leaves the group `rename`
      // map as the remaining authority for this record.
      out.push(rowName !== undefined ? { ...record, OBJECT_NAME: rowName } : applyGroupRename(record, def.rename));
      continue;
    }
    if (passAll || selectMatches(record, compiledSelect)) {
      out.push(applyGroupRename(record, def.rename));
    }
  }

  // Rows whose id matched no record: satellite gone from the group's sources.
  // A row marked `decayed` is expected never to match, so its silence is the
  // normal case — warning on it forever would bury a real disappearance in noise.
  // A decayed row that DOES match is the surprise, and says so.
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.noradId === undefined) {
      continue;
    }
    if (row.decayed) {
      if (matchedByRow[r]) {
        warnings.push(`noradId ${row.noradId}: marked decayed but matched a record`);
      }
      continue;
    }
    if (!matchedByRow[r]) {
      warnings.push(`noradId ${row.noradId}: matched no record in the group's sources`);
    }
  }

  return { records: out, warnings };
}

function applyGroupRename(record: OmmRecord, rename: GroupDefinition["rename"]): OmmRecord {
  const current = record.OBJECT_NAME;
  if (rename && current !== undefined && current in rename) {
    return { ...record, OBJECT_NAME: rename[current]! };
  }
  return record;
}

// The groups a definition needs evaluated before itself.
function dependencies(def: GroupDefinition): string[] {
  return [...(def.include ?? []), ...(def.exclude ?? [])];
}

// Topologically order group definitions by their `include` and `exclude` edges
// so that referenced groups are always evaluated before their consumers.
// Assumes the graph is acyclic and all targets exist (the generator validates
// both), but is written to terminate even if that guarantee is somehow
// violated.
function topoOrder(defs: GroupDefinition[]): GroupDefinition[] {
  const byName = new Map(defs.map((def) => [def.name, def]));
  const ordered: GroupDefinition[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (def: GroupDefinition): void => {
    const status = state.get(def.name);
    if (status === "done" || status === "visiting") {
      return;
    }
    state.set(def.name, "visiting");
    for (const dep of dependencies(def)) {
      const depDef = byName.get(dep);
      if (depDef) {
        visit(depDef);
      }
    }
    state.set(def.name, "done");
    ordered.push(def);
  };
  for (const def of defs) {
    visit(def);
  }
  return ordered;
}

// A group this one depends on, evaluated earlier by topo order. Its failure is
// this group's failure: an include would serve a hole, an exclude a duplicate.
function dependencyRecords(results: Map<string, GroupResult | Error>, dep: string, role: "included" | "excluded"): GpRecord[] {
  const result = results.get(dep);
  if (result === undefined) {
    throw new Error(`${role} group ${dep} was not evaluated`);
  }
  if (result instanceof Error) {
    throw new Error(`${role} group ${dep} failed: ${result.message}`);
  }
  return result.records;
}

// A successfully evaluated group: its final record list plus any non-fatal
// validation warnings raised by its `satellites` rows. Warnings are per-group
// (own rows only — a group does not inherit its includes' warnings; those
// surface on the included group's own status).
export interface GroupResult {
  records: GpRecord[];
  warnings: string[];
}

// Evaluate every group into its final record list. A group whose source failed
// (or whose included group failed) evaluates to an Error value rather than
// throwing; a successful group evaluates to a GroupResult carrying its records
// and warnings.
export function evaluateGroups(defs: GroupDefinition[], recordsBySource: RecordsBySource): Map<string, GroupResult | Error> {
  const results = new Map<string, GroupResult | Error>();
  for (const def of topoOrder(defs)) {
    try {
      // Concat source records (propagating any source failure). Sources always
      // yield OMM records (parseOmmArray validates the shape); TLE extras and
      // includes only join after select/rename.
      let sourceRecords: OmmRecord[] = [];
      for (const spec of def.sources ?? []) {
        const fetched = recordsBySource.get(sourceKey(spec));
        if (fetched === undefined) {
          throw new Error(`source ${sourceKey(spec)} was not fetched`);
        }
        if (fetched instanceof Error) {
          throw new Error(`source ${sourceKey(spec)} failed: ${fetched.message}`);
        }
        sourceRecords = sourceRecords.concat(fetched);
      }

      const selected = applySelectAndRename(sourceRecords, def);

      const included = (def.include ?? []).flatMap((dep) => dependencyRecords(results, dep, "included"));
      const excluded = new Set((def.exclude ?? []).flatMap((dep) => dependencyRecords(results, dep, "excluded").map(enrichmentSatnum)));

      // Final order: includes, then this group's own records, then extras. The
      // exclusion applies to all of it, not only to what this group selected.
      const records = [...included, ...selected.records, ...(def.extraRecords ?? [])].filter((record) => !excluded.has(enrichmentSatnum(record)));
      results.set(def.name, { records, warnings: selected.warnings });
    } catch (err) {
      results.set(def.name, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return results;
}

// The satnum a record is enriched under. Unlike recordSatnum (which feeds
// `select` matching and must keep its exact historical string form), this
// normalizes so a table entry keyed on 5 matches a NORAD_CAT_ID of 5, "5" or
// "00005" alike, and it reaches TleRecords too by reading columns 3-8 of line 1 —
// pseudo element sets in `extraRecords` have no NORAD_CAT_ID field.
//
// Alpha-5 designators ("E8493") normalize to themselves and so never match a
// table entry, whose noradId is numeric by definition.
function enrichmentSatnum(record: GpRecord): string {
  // A plain `"TLE_LINE1" in record` cannot narrow here: OmmRecord's index
  // signature admits the key, so the check leaves the value `unknown`.
  const line1 = (record as { TLE_LINE1?: unknown }).TLE_LINE1;
  const raw = typeof line1 === "string" ? line1.substring(2, 7) : String((record as OmmRecord).NORAD_CAT_ID ?? "");
  return normalizeSatnumKey(raw);
}

// The normalization every satellite-table key goes through, on both sides of the
// join. Exported so the SATCAT parser keys its rows exactly as enrichmentSatnum
// looks them up — the two cannot drift into a silently empty join.
export function normalizeSatnumKey(raw: string): string {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? String(parseInt(trimmed, 10)) : trimmed;
}

// Index a satellite table by satnum for O(1) enrichment lookups. Entry ids are
// numeric by definition, so they need no normalization on this side; the record
// side does (see enrichmentSatnum).
export function indexSatellitesByNoradId(entries: SatelliteEntry[]): Map<string, SatelliteEntry> {
  return new Map(entries.map((entry) => [String(entry.noradId), entry]));
}

// All enrichment needs of a satellite-table row. Narrower than SatelliteEntry on
// purpose: the merged table refreshGroups builds also holds rows that came from
// SATCAT alone, which have a satnum (the map key) but no curated `noradId`/`name`
// to report. Asking for only the bag keeps those rows from having to invent one.
export interface SatelliteFacts {
  metadata: Record<string, unknown>;
}

// Attach each matching table entry's metadata to a copy of the record, under the
// lowercase `metadata` key (lowercase to stand apart from the SCREAMING_SNAKE
// CCSDS fields, and because CelesTrak emits no lowercase keys — so it cannot
// collide with an upstream field).
//
// Records with no table entry are returned untouched and carry no `metadata` key
// at all: the frontend applies its own defaults, so enriching all ~10,000 records
// with a default bag would inflate every payload to say nothing. The returned
// satnum set lets the caller report entries that matched nothing anywhere.
export function enrichRecords(records: GpRecord[], table: Map<string, SatelliteFacts>): { records: GpRecord[]; matched: Set<string> } {
  const matched = new Set<string>();
  if (table.size === 0) {
    return { records, matched };
  }
  const out = records.map((record) => {
    const satnum = enrichmentSatnum(record);
    const entry = table.get(satnum);
    if (entry === undefined) {
      return record;
    }
    matched.add(satnum);
    return { ...record, metadata: entry.metadata };
  });
  return { records: out, matched };
}

// Coerce a possibly-missing or corrupt raw index value into a valid
// GroupsIndex, falling back to an empty index.
export function coerceIndex(raw: unknown): GroupsIndex {
  if (raw && typeof raw === "object" && Array.isArray((raw as GroupsIndex).groups)) {
    return raw as GroupsIndex;
  }
  return { updated: "", groups: [] };
}

// Build the per-group status index for a refresh run. Failed groups keep the
// previous run's `updated`/`count` (their last-known-good data remains served)
// and gain lastError/lastErrorAt; successful groups report fresh values.
// Shared by the worker cron refresh and the static snapshot generator so the
// last-known-good semantics cannot diverge.
export function buildStatuses(defs: GroupDefinition[], evaluated: Map<string, GroupResult | Error>, previousIndex: GroupsIndex, now: string): GroupStatus[] {
  const previousByName = new Map(previousIndex.groups.map((status) => [status.name, status]));
  return defs.map((def) => {
    const result = evaluated.get(def.name);
    if (result === undefined || result instanceof Error) {
      const message = result instanceof Error ? result.message : "not evaluated";
      const prev = previousByName.get(def.name);
      return { name: def.name, updated: prev?.updated ?? null, count: prev?.count ?? 0, lastError: message, lastErrorAt: now };
    }
    const status: GroupStatus = { name: def.name, updated: now, count: result.records.length };
    if (result.warnings.length > 0) {
      status.warnings = result.warnings;
    }
    return status;
  });
}
