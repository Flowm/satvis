// No Cloudflare APIs here: the static generator imports this file through node type stripping.

import type { GpRecord, GroupDefinition, GroupsConfig, GroupsIndex, GroupStatus, OmmRecord, SatelliteEntry, SatelliteSpec, SourceSpec } from "./types.ts";

const CELESTRAK_BASE = "https://celestrak.org/NORAD/elements/";
const USER_AGENT = "satvis.space (https://github.com/Flowm/satvis)";
// CelesTrak asks clients to space out requests.
const REQUEST_SPACING_MS = 250;
// Aborts a stalled source, so one hung upstream cannot push the sequential refresh
// past the cron / 120 s /__scheduled limit. CelesTrak's largest groups need far less.
const REQUEST_TIMEOUT_MS = 30_000;

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

// A failed source maps to an Error, so it breaks only the groups that use it.
export type RecordsBySource = Map<string, OmmRecord[] | Error>;

export type FetchImpl = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  status: number;
  // Optional, so a replayed bundle (bundleFetch) can omit it. Only the SATCAT fetch reads it, for the ETag.
  headers?: { get: (name: string) => string | null };
  text: () => Promise<string>;
}>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// CelesTrak serves HTML error pages with HTTP 200, so check the body shape too.
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

// `records` on success, else `error`. `status` / `bytes` / `bodySample` are set when
// the fetch got that far, which tells a bad body from a dead connection.
export interface SourceFetch {
  key: string;
  url: string;
  ms: number;
  status?: number;
  bytes?: number;
  records?: OmmRecord[];
  error?: string;
  bodySample?: string;
}

// Never throws.
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
      // The origin answered with something that is not OMM; the sample makes the logs diagnosable.
      return { key, url, ms, status: res.status, bytes: body.length, error: parseErr instanceof Error ? parseErr.message : String(parseErr), bodySample: body.slice(0, 120) };
    }
  } catch (err) {
    // Never reached the origin: DNS, TLS or connection failure, or the abort timer (522-class stalls).
    return { key, url, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Never throws. It logs before each fetch, so the last line printed names a stalled source.
export async function fetchSources(defs: GroupDefinition[], fetchImpl: FetchImpl): Promise<SourceFetch[]> {
  const specs = collectSources(defs);
  const results: SourceFetch[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    if (i > 0) {
      // Sequential on purpose, to spare CelesTrak; do not parallelize.
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
      const sample = r.bodySample ? ` body=${JSON.stringify(r.bodySample.replace(/\s+/g, " ").trim())}` : "";
      console.warn(`gp fetch ${label} ${r.key}: FAILED after ${r.ms}ms — ${r.error}${sample}`);
    }
    results.push(r);
  }
  return results;
}

export function toRecordsBySource(fetched: SourceFetch[]): RecordsBySource {
  const map: RecordsBySource = new Map();
  for (const r of fetched) {
    map.set(r.key, r.records ?? new Error(r.error ?? "fetch failed"));
  }
  return map;
}

// JSON-safe fetch diagnostics for the /api/refresh report. Failures such as 522s
// reproduce only from the Worker's egress, so the caller must see what came back.
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

// The raw NORAD_CAT_ID of an OMM record. Unlike enrichmentSatnum it does not normalize
// or read TLEs: selection semantics are frozen, so do not unify the two.
function recordSatnum(record: GpRecord): string | undefined {
  const id = (record as OmmRecord).NORAD_CAT_ID;
  return id === undefined || id === null ? undefined : String(id);
}

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

// A row matches by noradId, or else by exact upstreamName; the generator rejects a
// row with neither. Each map holds ascending row indices per key.
interface CompiledRows {
  bySatnum: Map<string, number[]>;
  byName: Map<string, number[]>;
}

// Buckets stay ascending because compileRows appends by increasing index.
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

// Ascending, so the lowest row index wins the rename.
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

interface SelectResult {
  records: OmmRecord[];
  warnings: string[];
}

// Selects by the union of `satellites` rows and `select`. A row's `name` beats the
// group `rename` map, which renames whatever no row did.
function applySelectAndRename(records: OmmRecord[], def: GroupDefinition): SelectResult {
  const rows = def.satellites ?? [];
  const warnings: string[] = [];
  const matchedByRow = rows.map(() => false);
  const out: OmmRecord[] = [];
  const compiledRows = compileRows(rows);
  const compiledSelect = compileSelect(def.select);
  const passAll = rows.length === 0 && !def.select;

  for (const record of records) {
    const indices = matchingRowIndices(record, compiledRows);
    let matchedRow = false;
    let rowName: string | undefined;
    for (const r of indices) {
      const row = rows[r]!;
      matchedByRow[r] = true;
      if (row.noradId !== undefined && row.upstreamName !== undefined && recordName(record) !== row.upstreamName) {
        warnings.push(`noradId ${row.noradId}: expected OBJECT_NAME ${JSON.stringify(row.upstreamName)}, got ${JSON.stringify(recordName(record))}`);
      }
      // The first row with a `name` wins; later rows are only marked matched.
      if (rowName === undefined && row.name !== undefined) {
        rowName = row.name;
      }
      matchedRow = true;
    }
    if (matchedRow) {
      out.push(rowName !== undefined ? { ...record, OBJECT_NAME: rowName } : applyGroupRename(record, def.rename));
      continue;
    }
    if (passAll || selectMatches(record, compiledSelect)) {
      out.push(applyGroupRename(record, def.rename));
    }
  }

  // An unmatched row warns, except a `decayed` one, where only a match warns.
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

function dependencies(def: GroupDefinition): string[] {
  return [...(def.include ?? []), ...(def.exclude ?? [])];
}

// The generator rejects cycles and missing targets; this still terminates if one slips through.
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

// `warnings` cover the group's own rows only, not those of its includes.
export interface GroupResult {
  records: GpRecord[];
  warnings: string[];
}

// A group whose source or dependency failed maps to an Error.
export function evaluateGroups(defs: GroupDefinition[], recordsBySource: RecordsBySource): Map<string, GroupResult | Error> {
  const results = new Map<string, GroupResult | Error>();
  for (const def of topoOrder(defs)) {
    try {
      // Sources yield only OMM records (parseOmmArray checks); TLE extras and includes join after select.
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

// Normalized, so key 5 matches a NORAD_CAT_ID of 5, "5" or "00005". TleRecords are
// read from columns 3-7 of line 1, because pseudo element sets in `extraRecords`
// have no NORAD_CAT_ID. Alpha-5 ids ("E8493") never match a numeric table key.
function enrichmentSatnum(record: GpRecord): string {
  // `"TLE_LINE1" in record` cannot narrow: OmmRecord's index signature admits the key.
  const line1 = (record as { TLE_LINE1?: unknown }).TLE_LINE1;
  const raw = typeof line1 === "string" ? line1.substring(2, 7) : String((record as OmmRecord).NORAD_CAT_ID ?? "");
  return normalizeSatnumKey(raw);
}

// Both sides of the satellite-table join use this, so the SATCAT parser keys rows
// exactly as enrichmentSatnum looks them up.
export function normalizeSatnumKey(raw: string): string {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? String(parseInt(trimmed, 10)) : trimmed;
}

// Entry ids are numeric, so only the record side needs normalizing.
export function indexSatellitesByNoradId(entries: SatelliteEntry[]): Map<string, SatelliteEntry> {
  return new Map(entries.map((entry) => [String(entry.noradId), entry]));
}

// Narrower than SatelliteEntry: SATCAT-only rows in the merged table have no
// curated `noradId`/`name`.
export interface SatelliteFacts {
  metadata: Record<string, unknown>;
}

// Lowercase `metadata` cannot collide with a CelesTrak field, which are all upper
// case. Unmatched records get no key at all: the frontend applies its defaults.
// `matched` lets the caller report table entries that matched nothing.
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

export function coerceIndex(raw: unknown): GroupsIndex {
  if (raw && typeof raw === "object" && Array.isArray((raw as GroupsIndex).groups)) {
    return raw as GroupsIndex;
  }
  return { updated: "", groups: [] };
}

// Lays the config's tags and presets over a stored index. The API applies it too,
// so a deploy that changes them takes effect before the next refresh.
export function withConfig(index: GroupsIndex, config: GroupsConfig): GroupsIndex {
  const stored = new Map(index.groups.map((status) => [status.name, status]));
  const groups = config.groups.map((def): GroupStatus => {
    const { tags: _stale, ...status } = stored.get(def.name) ?? { name: def.name, updated: null, count: 0 };
    return def.tags === undefined ? status : { ...status, tags: def.tags };
  });
  const presets = Object.fromEntries((config.presets ?? []).map(({ name, ...preset }) => [name, preset]));
  return { ...index, groups, presets };
}

// A failed group keeps the previous `updated`/`count`, because its last-known-good
// data still serves. The static generator shares this, so the two cannot diverge.
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
