// The group evaluator: pure, from the fetched sources' records to each group's records.
// No Cloudflare APIs here: the static generator imports this file through node type stripping.

import { enrichmentSatnum } from "./satnum.ts";
import { type RecordsBySource, sourceKey } from "./sources.ts";
import type { GpRecord, GroupDefinition, OmmRecord, SatelliteSpec } from "./types.ts";

function recordName(record: GpRecord): string {
  return record.OBJECT_NAME ?? "";
}

/**
 * The raw NORAD_CAT_ID of an OMM record. Unlike enrichmentSatnum it does not normalize
 * or read TLEs: selection semantics are frozen, so do not unify the two.
 */
function recordSatnum(record: GpRecord): string | undefined {
  const id = (record as OmmRecord).NORAD_CAT_ID;
  return id === undefined || id === null ? undefined : String(id);
}

/**
 * A row matches by noradId, or else by exact upstreamName; the generator rejects a
 * row with neither. Each map holds ascending row indices per key.
 */
interface CompiledRows {
  bySatnum: Map<string, number[]>;
  byName: Map<string, number[]>;
}

/** Buckets stay ascending because compileRows appends by increasing index. */
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

/** Ascending, so the lowest row index wins the rename. */
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

/** Selects by the union of `satellites` rows and `select`; a row's `name` renames its record. */
function applySelectAndRename(records: OmmRecord[], def: GroupDefinition): SelectResult {
  const rows = def.satellites ?? [];
  const warnings: string[] = [];
  const matchedByRow = rows.map(() => false);
  const out: OmmRecord[] = [];
  const compiledRows = compileRows(rows);
  const pattern = def.select?.namePattern ? new RegExp(def.select.namePattern) : undefined;
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
      out.push(rowName !== undefined ? { ...record, OBJECT_NAME: rowName } : record);
      continue;
    }
    if (passAll || pattern?.test(recordName(record))) {
      out.push(record);
    }
  }

  // A row warns when it matches no record. A `decayed` row is the reverse: it warns
  // only when it does match.
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

function dependencies(def: GroupDefinition): string[] {
  return [...(def.include ?? []), ...(def.exclude ?? [])];
}

/** The generator rejects cycles and missing targets; this still terminates if one slips through. */
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

/**
 * A group this one depends on, evaluated earlier by topo order. Its failure is
 * this group's failure: an include would serve a hole, an exclude a duplicate.
 */
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

/** `warnings` cover the group's own rows only, not those of its includes. */
export interface GroupResult {
  records: GpRecord[];
  warnings: string[];
}

/** A group whose source or dependency failed maps to an Error. */
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
