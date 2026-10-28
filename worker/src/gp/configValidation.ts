// The config schema's rules, checked by scripts/generate-groups.mjs before anything is
// written. Pure, so the tests reach every rule; the script keeps the YAML and file I/O.
// No Cloudflare APIs: the script imports it through node type stripping.

import { isModelPath } from "./modelLods.ts";
import { GROUP_NAME_RE, type PresetDefinition, type SatelliteEntry } from "./types.ts";

/** A config entry as YAML parsed it: nothing about its shape is trusted until it is checked here. */
type Raw = Record<string, any>;

/** A preset is reached at /<name>, so its name is a path segment. */
const PRESET_NAME_RE = /^[a-z0-9-]+$/;
const DEFAULT_PRESET = "default";

/** Contributions to the satellite table, from the configs and the model manifests. */
export interface SatelliteTableBuilder {
  /** Throws when `fields` sets a metadata field another origin set differently. */
  add(noradId: number, fields: { metadata: Raw; name?: string; decayed?: boolean }, origin: string): void;
  /** The merged entries, by NORAD id. */
  entries(): SatelliteEntry[];
}

function validateSatellites(group: Raw): void {
  if (group.satellites === undefined) {
    return;
  }
  if (!Array.isArray(group.satellites)) {
    throw new Error(`group ${JSON.stringify(group.name)}: "satellites" must be an array`);
  }
  group.satellites.forEach((row: Raw, i: number) => {
    const where = `group ${JSON.stringify(group.name)} satellites[${i}]`;
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${where}: must be an object`);
    }
    if (row.noradId !== undefined && typeof row.noradId !== "number") {
      throw new Error(`${where}: "noradId" must be a number`);
    }
    if (row.upstreamName !== undefined && typeof row.upstreamName !== "string") {
      throw new Error(`${where}: "upstreamName" must be a string`);
    }
    if (row.noradId === undefined && row.upstreamName === undefined) {
      throw new Error(`${where}: must have a "noradId" or "upstreamName"`);
    }
    if (row.name !== undefined && typeof row.name !== "string") {
      throw new Error(`${where}: "name" must be a string`);
    }
    if (row.metadata !== undefined) {
      validateMetadata(row.metadata, where);
      if (row.noradId === undefined) {
        throw new Error(`${where}: "metadata" requires a "noradId" (matching is by NORAD id only)`);
      }
      // A served record carries `metadata` only when there are facts to carry.
      if (Object.keys(row.metadata).length === 0) {
        throw new Error(`${where}: "metadata" is empty — remove it or give it a field`);
      }
    }
    if (row.decayed !== undefined && typeof row.decayed !== "boolean") {
      throw new Error(`${where}: "decayed" must be a boolean`);
    }
  });
}

/**
 * The swath extents are checked because swathExtentsOf in src/config/satelliteMetadata.ts
 * reads them as a pair and treats a half-specified swath as absent; `modelFile` because
 * the app puts it under ./data/models/.
 */
function validateMetadata(metadata: Raw, where: string): void {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${where}: "metadata" must be an object`);
  }
  const sides = ["swathStarboardKm", "swathPortKm"];
  for (const side of sides) {
    const value = metadata[side];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      throw new Error(`${where}: "${side}" must be a positive number`);
    }
  }
  const given = sides.filter((side) => metadata[side] !== undefined);
  if (given.length === 1) {
    throw new Error(`${where}: swath needs both "swathStarboardKm" and "swathPortKm" (got only ${JSON.stringify(given[0])})`);
  }
  if (metadata.modelFile !== undefined && !isModelPath(metadata.modelFile)) {
    throw new Error(`${where}: "modelFile" must be a .glb path under /data/models/ (got ${JSON.stringify(metadata.modelFile)})`);
  }
  // The refresh derives it from modelFile (ADR 0007), so a row's would reach only new apps.
  if (metadata.model !== undefined) {
    throw new Error(`${where}: "model" is derived from "modelFile"; name the file there`);
  }
}

/** Every other key of a table entry is metadata, so a new field needs no code change. */
const TABLE_ENTRY_KEYS = new Set(["noradId", "name", "decayed"]);

export function metadataFields(entry: Raw): Raw {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !TABLE_ENTRY_KEYS.has(key)));
}

export function validateSatelliteTable(entries: unknown, source: string): void {
  if (!Array.isArray(entries)) {
    throw new Error(`${source}: "satellites" must be an array`);
  }
  entries.forEach((entry: Raw, i) => {
    const where = `${source} satellites[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${where}: must be an object`);
    }
    if (typeof entry.noradId !== "number") {
      throw new Error(`${where}: "noradId" must be a number`);
    }
    if (entry.name !== undefined && typeof entry.name !== "string") {
      throw new Error(`${where}: "name" must be a string`);
    }
    if (entry.decayed !== undefined && typeof entry.decayed !== "boolean") {
      throw new Error(`${where}: "decayed" must be a boolean`);
    }
    const metadata = metadataFields(entry);
    validateMetadata(metadata, where);
    if (Object.keys(metadata).length === 0) {
      throw new Error(`${where}: has no metadata fields — remove the entry or give it something to attach`);
    }
  });
}

/** Tags travel comma-joined in the `tags` url parameter, hence no commas. */
function validateTags(group: Raw): void {
  if (group.tags === undefined) {
    return;
  }
  const where = `group ${JSON.stringify(group.name)}`;
  if (!Array.isArray(group.tags) || group.tags.length === 0) {
    throw new Error(`${where}: "tags" must be a non-empty array`);
  }
  for (const tag of group.tags) {
    if (typeof tag !== "string" || tag.trim() === "" || tag.includes(",")) {
      throw new Error(`${where}: tag ${JSON.stringify(tag)} must be a non-empty string without a comma`);
    }
  }
}

/** The keys the evaluator reads; it ignores any other, so a removed or misspelt one fails here. */
const GROUP_KEYS = new Set(["name", "sources", "select", "satellites", "include", "exclude", "extraRecords", "tags"]);

function validateKeys(group: Raw): void {
  const where = `group ${JSON.stringify(group.name)}`;
  const unknown = Object.keys(group).find((key) => !GROUP_KEYS.has(key)) ?? Object.keys(group.select ?? {}).find((key) => key !== "namePattern");
  if (unknown !== undefined) {
    throw new Error(`${where}: unknown key ${JSON.stringify(unknown)}`);
  }
  for (const source of group.sources ?? []) {
    if (typeof source?.celestrak !== "string" || Object.keys(source).length !== 1) {
      throw new Error(`${where}: a source must be { celestrak: <CelesTrak group> }, not ${JSON.stringify(source)}`);
    }
  }
}

export function validateGroups(groups: Raw[]): void {
  const names = new Set();
  for (const group of groups) {
    if (typeof group.name !== "string" || !GROUP_NAME_RE.test(group.name)) {
      throw new Error(`invalid group name ${JSON.stringify(group.name)} (must match ${GROUP_NAME_RE})`);
    }
    if (names.has(group.name)) {
      throw new Error(`duplicate group name ${JSON.stringify(group.name)}`);
    }
    names.add(group.name);
    validateKeys(group);
    validateSatellites(group);
    validateTags(group);
  }
  for (const group of groups) {
    for (const [field, verb] of [
      ["include", "includes"],
      ["exclude", "excludes"],
    ] as const) {
      const deps = group[field] ?? [];
      if (!Array.isArray(deps) || deps.some((dep) => typeof dep !== "string")) {
        throw new Error(`group ${JSON.stringify(group.name)}: "${field}" must be an array of group names`);
      }
      for (const dep of deps) {
        if (!names.has(dep)) {
          throw new Error(`group ${JSON.stringify(group.name)} ${verb} unknown group ${JSON.stringify(dep)}`);
        }
        if (dep === group.name) {
          throw new Error(`group ${JSON.stringify(group.name)} ${verb} itself`);
        }
      }
    }
  }
  const byName = new Map(groups.map((g) => [g.name, g]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, stack: string[]): void => {
    if (state.get(name) === "done") {
      return;
    }
    if (state.get(name) === "visiting") {
      throw new Error(`include/exclude cycle detected: ${[...stack, name].join(" -> ")}`);
    }
    state.set(name, "visiting");
    const group = byName.get(name);
    for (const dep of [...(group?.include ?? []), ...(group?.exclude ?? [])]) {
      visit(dep, [...stack, name]);
    }
    state.set(name, "done");
  };
  for (const group of groups) {
    visit(group.name, []);
  }
}

const sourcesOf = (group: Raw): string => JSON.stringify(group.sources ?? []);

/**
 * A remainder must exclude every sibling in its config that selects from the same
 * sources, or it serves their records twice. Each config is checked on its own.
 */
export function validateRemainders(groups: Raw[], source: string): void {
  for (const remainder of groups) {
    if (!remainder.exclude) {
      continue;
    }
    for (const sibling of groups) {
      if (sibling === remainder || sourcesOf(sibling) !== sourcesOf(remainder) || (!sibling.select && !sibling.satellites)) {
        continue;
      }
      if (!remainder.exclude.includes(sibling.name)) {
        throw new Error(`${source}: group ${JSON.stringify(remainder.name)} must exclude ${JSON.stringify(sibling.name)}, which selects from the same sources`);
      }
    }
  }
}

/** Enabling a tag of a remainder must load the whole, so excluded groups carry all its tags. */
export function validateRemainderTags(groups: Raw[]): void {
  const byName = new Map(groups.map((group) => [group.name, group]));
  for (const remainder of groups) {
    for (const name of remainder.exclude ?? []) {
      const missing = (remainder.tags ?? []).filter((tag: string) => !(byName.get(name)?.tags ?? []).includes(tag));
      if (missing.length > 0) {
        throw new Error(
          `group ${JSON.stringify(name)} must carry tag(s) ${missing.map((tag: string) => JSON.stringify(tag)).join(", ")} of ${JSON.stringify(remainder.name)}, which excludes it`,
        );
      }
    }
  }
}

/** A preset group entry is a bare name or { name, searchOnly }; it comes out as the object. */
export function validatePresets(presets: Raw[], groups: Raw[]): PresetDefinition[] {
  const byName = new Map(groups.map((group) => [group.name, group]));
  const seen = new Set();
  const normalized = presets.map((preset, i): PresetDefinition => {
    const where = `preset ${JSON.stringify(preset?.name ?? i)}`;
    if (preset === null || typeof preset !== "object" || Array.isArray(preset)) {
      throw new Error(`presets[${i}]: must be an object`);
    }
    if (typeof preset.name !== "string" || !PRESET_NAME_RE.test(preset.name)) {
      throw new Error(`${where}: "name" must match ${PRESET_NAME_RE}`);
    }
    if (seen.has(preset.name)) {
      throw new Error(`duplicate preset name ${JSON.stringify(preset.name)}`);
    }
    seen.add(preset.name);
    for (const key of ["title", "description"]) {
      if (preset[key] !== undefined && typeof preset[key] !== "string") {
        throw new Error(`${where}: "${key}" must be a string`);
      }
    }
    const defaults = preset.defaults ?? {};
    if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) {
      throw new Error(`${where}: "defaults" must be an object of url parameters`);
    }
    for (const [param, value] of Object.entries(defaults)) {
      if (typeof value !== "string") {
        throw new Error(`${where}: default ${JSON.stringify(param)} must be a string, as the url would carry it`);
      }
    }
    if (!Array.isArray(preset.groups) || preset.groups.length === 0) {
      throw new Error(`${where}: "groups" must be a non-empty array`);
    }
    const presetGroups = preset.groups.map((entry) => {
      const { name, searchOnly } = typeof entry === "string" ? { name: entry } : (entry ?? {});
      const group = byName.get(name);
      if (group === undefined) {
        throw new Error(`${where}: unknown group ${JSON.stringify(name)}`);
      }
      if (group.tags === undefined) {
        // An untagged group could be registered but never enabled.
        throw new Error(`${where}: group ${JSON.stringify(name)} has no tags`);
      }
      if (searchOnly !== undefined && typeof searchOnly !== "boolean") {
        throw new Error(`${where}: group ${JSON.stringify(name)}: "searchOnly" must be a boolean`);
      }
      return searchOnly ? { name, searchOnly } : { name };
    });
    // The one default checked here: a tag no registered group carries enables nothing.
    const carried = new Set(presetGroups.flatMap(({ name }) => byName.get(name)!.tags as string[]));
    for (const tag of (defaults.tags ?? "").split(",").filter((name: string) => name !== "")) {
      if (!carried.has(tag)) {
        throw new Error(`${where}: default tag ${JSON.stringify(tag)} is carried by none of its groups`);
      }
    }
    return { ...preset, groups: presetGroups } as PresetDefinition;
  });
  if (!seen.has(DEFAULT_PRESET)) {
    throw new Error(`no ${JSON.stringify(DEFAULT_PRESET)} preset: every route that names none falls back to it`);
  }
  return normalized;
}

/**
 * Merges contributions field by field. Two different values for one field fail the
 * build, because the winner would depend on discovery order; identical values merge.
 */
export function createSatelliteTable(): SatelliteTableBuilder {
  const byNoradId = new Map<number, { noradId: number; metadata: Raw; origins: string[]; name?: string; decayed?: boolean }>();
  return {
    add(noradId, fields, origin) {
      const existing = byNoradId.get(noradId);
      if (existing === undefined) {
        byNoradId.set(noradId, { noradId, metadata: { ...fields.metadata }, origins: [origin], name: fields.name, decayed: fields.decayed });
        return;
      }
      for (const [key, value] of Object.entries(fields.metadata)) {
        const previous = existing.metadata[key];
        if (previous !== undefined && previous !== value) {
          throw new Error(
            `conflicting metadata for noradId ${noradId}: ${origin} sets ${key}=${JSON.stringify(value)}, ` +
              `but ${existing.origins.join(", ")} set ${key}=${JSON.stringify(previous)}`,
          );
        }
        existing.metadata[key] = value;
      }
      existing.name ??= fields.name;
      existing.decayed ||= fields.decayed;
      existing.origins.push(origin);
    },
    entries() {
      const out: SatelliteEntry[] = [];
      for (const { noradId, name, decayed, metadata } of byNoradId.values()) {
        const entry: Raw = { noradId };
        if (name !== undefined) {
          entry.name = name;
        }
        if (decayed) {
          entry.decayed = true;
        }
        entry.metadata = metadata;
        out.push(entry as SatelliteEntry);
      }
      return out.toSorted((a, b) => a.noradId - b.noradId);
    },
  };
}
