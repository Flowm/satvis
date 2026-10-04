#!/usr/bin/env node
// Merge the committed core config with every data/custom/*/satvis.yaml plugin
// config, inline each group's extraRecordsFile TLE text into extraRecords,
// give every satellite a model manifest lists its `modelFile`, validate, and
// write worker/src/config/satvis.generated.json.
//
// A config contributes three independent sections: `groups` (what is served, as
// which unit, under which tags), `presets` (the starting configuration of a
// route) and `satellites` (static per-satellite facts, keyed by NORAD id and
// attached to records at refresh time). With no plugin configs present this
// still produces a valid generated file from the core config alone (so lint/CI
// stay green).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(workerDir, "..");

const coreConfigPath = path.join(workerDir, "src", "config", "satvis.core.yaml");
const customDir = path.join(repoRoot, "data", "custom");
const outPath = path.join(workerDir, "src", "config", "satvis.generated.json");

const PLUGIN_CONFIG_NAME = "satvis.yaml";
// A model manifest: the models submodule's (data/models) and any plugin's that
// ships models of its own. Each lists files under /data/models/ and the NORAD ids
// they depict.
const MODEL_MANIFEST_NAME = "models.yaml";
const modelsManifestPath = path.join(repoRoot, "data", "models", MODEL_MANIFEST_NAME);
// Pre-YAML plugin config name. Detected only to fail loudly: silently skipping
// it would make a plugin's groups vanish from the build without a word.
const LEGACY_PLUGIN_CONFIG_NAME = "groups.json";

const GROUP_NAME_RE = /^[a-zA-Z0-9_-]+$/;
// A preset is reached at /<name>, so its name is a path segment.
const PRESET_NAME_RE = /^[a-z0-9-]+$/;
const DEFAULT_PRESET = "default";

function readYaml(file) {
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

// Parse TLE text into TleRecord objects. Supports 3-line blocks (optional
// leading "0 " on the name line), and bare 2-line blocks (no name).
//
// Deliberate near-duplicate of src/modules/util/gp.ts parseTleText with an
// intentionally opposite error policy: this build tool fails loud (throws) so
// bad input never ships, while the browser path warns and skips. Do not
// "unify" them.
function parseTleText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
  const records = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("1 ") && i + 1 < lines.length && lines[i + 1].startsWith("2 ")) {
      // Bare 2-line block.
      records.push({ TLE_LINE1: line, TLE_LINE2: lines[i + 1] });
      i += 2;
    } else if (i + 2 < lines.length && lines[i + 1].startsWith("1 ") && lines[i + 2].startsWith("2 ")) {
      // 3-line block; strip an optional "0 " name prefix.
      const name = line.startsWith("0 ") ? line.slice(2) : line;
      records.push({ OBJECT_NAME: name, TLE_LINE1: lines[i + 1], TLE_LINE2: lines[i + 2] });
      i += 3;
    } else {
      throw new Error(`unrecognized TLE block at line ${i + 1}: ${JSON.stringify(line)}`);
    }
  }
  return records;
}

// Load and normalize one config file. `extraRecordsFile` (generator-only) is
// resolved relative to the config's directory and inlined into extraRecords.
function loadConfig(configPath) {
  const config = readYaml(configPath);
  const dir = path.dirname(configPath);
  const groups = (config.groups ?? []).map((group) => {
    const { extraRecordsFile, ...rest } = group;
    if (extraRecordsFile) {
      const txtPath = path.join(dir, extraRecordsFile);
      const parsed = parseTleText(fs.readFileSync(txtPath, "utf8"));
      rest.extraRecords = [...(rest.extraRecords ?? []), ...parsed];
    }
    return rest;
  });
  return { groups, presets: config.presets ?? [], satellites: config.satellites ?? [] };
}

function discoverPluginConfigs() {
  if (!fs.existsSync(customDir)) {
    return [];
  }
  const configs = [];
  for (const entry of fs.readdirSync(customDir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(customDir, entry.name);
    const candidate = path.join(dir, PLUGIN_CONFIG_NAME);
    if (fs.existsSync(candidate)) {
      configs.push(candidate);
      continue;
    }
    // Fail loudly rather than silently dropping a plugin that has not migrated.
    if (fs.existsSync(path.join(dir, LEGACY_PLUGIN_CONFIG_NAME))) {
      throw new Error(
        `${path.relative(repoRoot, path.join(dir, LEGACY_PLUGIN_CONFIG_NAME))} is the pre-YAML config format; ` +
          `rename it to ${PLUGIN_CONFIG_NAME} and convert it to YAML (see worker/src/config/satvis.core.yaml)`,
      );
    }
  }
  return configs;
}

// Every model manifest present. The submodule's is missing in a checkout that never
// ran `git submodule update --init` (CI included); that is a warning, not a
// failure, so lint and tests run anywhere — but such a build gives no satellite
// one of its models, which the warning says.
function discoverModelManifests() {
  const manifests = [];
  if (fs.existsSync(modelsManifestPath)) {
    manifests.push(modelsManifestPath);
  } else {
    process.stderr.write(`warning: ${path.relative(repoRoot, modelsManifestPath)} not found, so no satellite gets one of its 3D models. Run \`git submodule update --init\`.\n`);
  }
  if (fs.existsSync(customDir)) {
    for (const entry of fs.readdirSync(customDir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
      const candidate = path.join(customDir, entry.name, MODEL_MANIFEST_NAME);
      if (entry.isDirectory() && fs.existsSync(candidate)) {
        manifests.push(candidate);
      }
    }
  }
  return manifests;
}

// `{ noradId, modelFile }` for every satellite a manifest lists. A model's `file`
// is its path under /data/models/, wherever it was copied from; the app adds the
// prefix, so the bag carries no URL.
function modelAssignments(manifestPath) {
  const source = path.relative(repoRoot, manifestPath);
  const dir = path.dirname(manifestPath);
  const { models } = readYaml(manifestPath) ?? {};
  if (!Array.isArray(models)) {
    throw new Error(`${source}: expected a top-level "models" list`);
  }
  return models.flatMap((model, i) => {
    if (typeof model?.file !== "string" || !model.file.endsWith(".glb") || model.file.startsWith("/") || model.file.includes("..")) {
      throw new Error(`${source}: models[${i}].file must be a .glb path under /data/models/ (got ${JSON.stringify(model?.file)})`);
    }
    // A typo would only show as a failed request in the browser. A plugin's
    // files are copied by its own sync script, so its layout is a guess: warn.
    if (!fs.existsSync(path.join(dir, "public", model.file))) {
      const message = `${source}: ${model.file} is not in ${path.relative(repoRoot, path.join(dir, "public"))}`;
      if (manifestPath === modelsManifestPath) {
        throw new Error(message);
      }
      process.stderr.write(`warning: ${message}\n`);
    }
    if (model.satellites !== undefined && !Array.isArray(model.satellites)) {
      throw new Error(`${source}: ${model.file} has a "satellites" that is not a list`);
    }
    return (model.satellites ?? []).map((satellite) => {
      if (!Number.isInteger(satellite?.noradId)) {
        throw new Error(`${source}: ${model.file} lists a satellite without a numeric noradId`);
      }
      return { noradId: satellite.noradId, modelFile: model.file, origin: `${source} ${model.file}` };
    });
  });
}

// Validate a group's `satellites` rows (if any). Each row must select by
// `noradId` (number) or `upstreamName` (string); `name`/`metadata` optional
// with checked types. Throws with the group name on any violation.
function validateSatellites(group) {
  if (group.satellites === undefined) {
    return;
  }
  if (!Array.isArray(group.satellites)) {
    throw new Error(`group ${JSON.stringify(group.name)}: "satellites" must be an array`);
  }
  group.satellites.forEach((row, i) => {
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
        // Metadata is keyed by NORAD id in the merged table; a name-only row has
        // no key to lift it under.
        throw new Error(`${where}: "metadata" requires a "noradId" (matching is by NORAD id only)`);
      }
      // Same rule as a top-level table entry: an empty bag would attach a
      // meaningless `metadata` key to the served record, which is supposed to be
      // present only when the satellite actually has facts to carry.
      if (Object.keys(row.metadata).length === 0) {
        throw new Error(`${where}: "metadata" is empty — remove it or give it a field`);
      }
    }
    if (row.decayed !== undefined && typeof row.decayed !== "boolean") {
      throw new Error(`${where}: "decayed" must be a boolean`);
    }
  });
}

// Validate a metadata bag. The worker treats it as opaque, so only the fields
// whose shape the frontend depends on are checked here: the swath extents, which
// must be positive numbers and must be given for both sides or neither (see
// swathExtentsOf in src/config/satelliteMetadata.ts, which reads them as a pair
// and treats a half-specified swath as absent).
function validateMetadata(metadata, where) {
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
}

// The keys of a satellite-table entry that are bookkeeping rather than payload.
// Everything else in the entry IS the metadata bag, which is what keeps adding a
// field a data-only edit.
const TABLE_ENTRY_KEYS = new Set(["noradId", "name", "decayed"]);

function metadataFields(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !TABLE_ENTRY_KEYS.has(key)));
}

// Validate a config's top-level `satellites` table. Every entry keys on a
// numeric `noradId`; `name` is documentation only.
function validateSatelliteTable(entries, source) {
  if (!Array.isArray(entries)) {
    throw new Error(`${source}: "satellites" must be an array`);
  }
  entries.forEach((entry, i) => {
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

// Tags travel comma-joined in the `tags` url parameter, hence no commas.
function validateTags(group) {
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

function validate(groups) {
  const names = new Set();
  for (const group of groups) {
    if (typeof group.name !== "string" || !GROUP_NAME_RE.test(group.name)) {
      throw new Error(`invalid group name ${JSON.stringify(group.name)} (must match ${GROUP_NAME_RE})`);
    }
    if (names.has(group.name)) {
      throw new Error(`duplicate group name ${JSON.stringify(group.name)}`);
    }
    names.add(group.name);
    validateSatellites(group);
    validateTags(group);
  }
  // include / exclude targets must exist, and must be other groups.
  for (const group of groups) {
    for (const [field, verb] of [
      ["include", "includes"],
      ["exclude", "excludes"],
    ]) {
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
  // no cycles through include or exclude edges (DFS).
  const byName = new Map(groups.map((g) => [g.name, g]));
  const state = new Map();
  const visit = (name, stack) => {
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

const sourcesOf = (group) => JSON.stringify(group.sources ?? []);

// A group with `exclude` serves the remainder of its sources, so every sibling
// in the same config that selects from those sources must be on the list, or
// the remainder serves those records twice. Plugin configs are checked on their
// own: their groups belong in a core remainder.
function validateRemainders(groups, source) {
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

// A remainder and the groups it excludes make up one whole, and enabling a tag
// of the remainder has to load all of it. So every excluded group carries every
// tag of the group excluding it.
function validateRemainderTags(groups) {
  const byName = new Map(groups.map((group) => [group.name, group]));
  for (const remainder of groups) {
    for (const name of remainder.exclude ?? []) {
      const missing = (remainder.tags ?? []).filter((tag) => !(byName.get(name)?.tags ?? []).includes(tag));
      if (missing.length > 0) {
        throw new Error(
          `group ${JSON.stringify(name)} must carry tag(s) ${missing.map((tag) => JSON.stringify(tag)).join(", ")} of ${JSON.stringify(remainder.name)}, which excludes it`,
        );
      }
    }
  }
}

// Normalize and check every preset against the merged groups. A group entry is
// either a bare name or { name, searchOnly }, and comes out as the object.
function validatePresets(presets, groups) {
  const byName = new Map(groups.map((group) => [group.name, group]));
  const seen = new Set();
  const normalized = presets.map((preset, i) => {
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
    const carried = new Set(presetGroups.flatMap(({ name }) => byName.get(name).tags));
    for (const tag of (defaults.tags ?? "").split(",").filter((name) => name !== "")) {
      if (!carried.has(tag)) {
        throw new Error(`${where}: default tag ${JSON.stringify(tag)} is carried by none of its groups`);
      }
    }
    return { ...preset, groups: presetGroups };
  });
  if (!seen.has(DEFAULT_PRESET)) {
    throw new Error(`no ${JSON.stringify(DEFAULT_PRESET)} preset: every route that names none falls back to it`);
  }
  return normalized;
}

// Accumulator for the merged satellite table, keyed by NORAD id. Contributions
// arrive from two kinds of place — a config's top-level `satellites` table and a
// group's `satellites[].metadata` rows — and are merged field-wise in arrival
// order, so a later, more specific contribution wins per field.
//
// Conflicts (two places giving one field different values for one satellite) are
// a config bug: whichever won would depend on file discovery order, so we fail
// with both origins instead of picking. Identical values merge silently, which
// is what makes it safe to repeat a satellite across groups.
function createSatelliteTable() {
  const byNoradId = new Map();
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
    // Strip the bookkeeping (`origins`) that only the merge needed, and drop
    // absent optional keys so the generated JSON stays free of nulls.
    entries() {
      const out = [];
      for (const { noradId, name, decayed, metadata } of byNoradId.values()) {
        const entry = { noradId };
        if (name !== undefined) {
          entry.name = name;
        }
        if (decayed) {
          entry.decayed = true;
        }
        entry.metadata = metadata;
        out.push(entry);
      }
      return out.toSorted((a, b) => a.noradId - b.noradId);
    },
  };
}

function main() {
  const configs = [
    { path: coreConfigPath, config: loadConfig(coreConfigPath) },
    ...discoverPluginConfigs().map((configPath) => ({ path: configPath, config: loadConfig(configPath) })),
  ];

  const groups = configs.flatMap(({ config }) => config.groups);
  validate(groups);
  validateRemainderTags(groups);
  const presets = validatePresets(
    configs.flatMap(({ config }) => config.presets),
    groups,
  );

  const table = createSatelliteTable();
  for (const { path: configPath, config } of configs) {
    const source = path.relative(repoRoot, configPath);
    validateRemainders(config.groups, source);
    validateSatelliteTable(config.satellites, source);
    for (const entry of config.satellites) {
      table.add(entry.noradId, { metadata: metadataFields(entry), name: entry.name, decayed: entry.decayed }, `${source} satellites`);
    }
  }
  // Group rows contribute after every table. Order only decides which origin is
  // named first in a conflict message — it does NOT establish precedence: two
  // places giving one satellite different values for a field is a build failure,
  // because whichever won would depend on config discovery order.
  for (const group of groups) {
    for (const row of group.satellites ?? []) {
      if (row.metadata !== undefined) {
        table.add(row.noradId, { metadata: row.metadata, name: row.name, decayed: row.decayed }, `group ${JSON.stringify(group.name)}`);
      }
    }
  }
  // Models last, through the same table: a plugin giving a mapped satellite a
  // different modelFile is a conflict like any other, not an override.
  for (const manifestPath of discoverModelManifests()) {
    for (const { noradId, modelFile, origin } of modelAssignments(manifestPath)) {
      table.add(noradId, { metadata: { modelFile } }, origin);
    }
  }
  const satellites = table.entries();

  const generated = { groups, presets, satellites };
  fs.writeFileSync(outPath, `${JSON.stringify(generated, null, 2)}\n`);
  process.stdout.write(`Wrote ${path.relative(repoRoot, outPath)} (${groups.length} groups, ${presets.length} presets, ${satellites.length} satellites)\n`);
}

main();
