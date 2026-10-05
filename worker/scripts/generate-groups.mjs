#!/usr/bin/env node
// Merge the core config with every data/custom/*/satvis.yaml, inline each
// extraRecordsFile, give each satellite its model manifest `modelFile`, validate,
// and write worker/src/config/satvis.generated.json. Works without plugins too.

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
// The submodule's and any plugin's list of files under /data/models/ by NORAD id (ADR 0007).
const MODEL_MANIFEST_NAME = "models.yaml";
const modelsManifestPath = path.join(repoRoot, "data", "models", MODEL_MANIFEST_NAME);
// Pre-YAML plugin config name, detected only to fail loudly instead of dropping the plugin.
const LEGACY_PLUGIN_CONFIG_NAME = "groups.json";

const GROUP_NAME_RE = /^[a-zA-Z0-9_-]+$/;
// A preset is reached at /<name>, so its name is a path segment.
const PRESET_NAME_RE = /^[a-z0-9-]+$/;
const DEFAULT_PRESET = "default";

function readYaml(file) {
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

// Near-duplicate of parseTleText in src/modules/util/gp.ts with the opposite error
// policy: this one throws so bad input never ships, the browser warns and skips. Do not unify them.
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
      records.push({ TLE_LINE1: line, TLE_LINE2: lines[i + 1] });
      i += 2;
    } else if (i + 2 < lines.length && lines[i + 1].startsWith("1 ") && lines[i + 2].startsWith("2 ")) {
      const name = line.startsWith("0 ") ? line.slice(2) : line;
      records.push({ OBJECT_NAME: name, TLE_LINE1: lines[i + 1], TLE_LINE2: lines[i + 2] });
      i += 3;
    } else {
      throw new Error(`unrecognized TLE block at line ${i + 1}: ${JSON.stringify(line)}`);
    }
  }
  return records;
}

// `extraRecordsFile` resolves relative to the config's directory.
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
    if (fs.existsSync(path.join(dir, LEGACY_PLUGIN_CONFIG_NAME))) {
      throw new Error(
        `${path.relative(repoRoot, path.join(dir, LEGACY_PLUGIN_CONFIG_NAME))} is the pre-YAML config format; ` +
          `rename it to ${PLUGIN_CONFIG_NAME} and convert it to YAML (see worker/src/config/satvis.core.yaml)`,
      );
    }
  }
  return configs;
}

// Without `git submodule update --init` (CI too) the submodule's manifest is missing: warn, so lint and tests still run.
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

// A model's `file` is its path under /data/models/; the app adds the prefix.
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
    // A plugin's sync script decides its layout, so public/ is only a guess there: warn.
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

// Only the swath extents are checked: swathExtentsOf in src/config/satelliteMetadata.ts
// reads them as a pair and treats a half-specified swath as absent.
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

// Every other key of a table entry is metadata, so a new field needs no code change.
const TABLE_ENTRY_KEYS = new Set(["noradId", "name", "decayed"]);

function metadataFields(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !TABLE_ENTRY_KEYS.has(key)));
}

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

// A remainder must exclude every sibling in its config that selects from the same
// sources, or it serves their records twice. Each config is checked on its own.
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

// Enabling a tag of a remainder must load the whole, so excluded groups carry all its tags.
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

// A preset group entry is a bare name or { name, searchOnly }; it comes out as the object.
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

// Merges contributions field by field. Two different values for one field fail the
// build, because the winner would depend on discovery order; identical values merge.
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
  // Order only decides which origin a conflict message names first; it sets no precedence.
  for (const group of groups) {
    for (const row of group.satellites ?? []) {
      if (row.metadata !== undefined) {
        table.add(row.noradId, { metadata: row.metadata, name: row.name, decayed: row.decayed }, `group ${JSON.stringify(group.name)}`);
      }
    }
  }
  // Through the same table, so a plugin's different modelFile is a conflict, not an override.
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
