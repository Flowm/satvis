#!/usr/bin/env node
// Merge the core config with every data/custom/*/satvis.yaml, inline each
// extraRecordsFile, give each listed satellite its model manifest `modelFile` and
// each named GCAT bus its model, validate, and write
// worker/src/config/satvis.generated.json. Works without plugins too.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import {
  createSatelliteTable,
  metadataFields,
  validateGroups,
  validatePresets,
  validateRemainders,
  validateRemainderTags,
  validateSatelliteTable,
} from "../src/gp/configValidation.ts";
import { isGcatBusName, modelsByBus } from "../src/gp/modelBuses.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(workerDir, "..");

const coreConfigPath = path.join(workerDir, "src", "config", "satvis.core.yaml");
const customDir = path.join(repoRoot, "data", "custom");
const outPath = path.join(workerDir, "src", "config", "satvis.generated.json");

const PLUGIN_CONFIG_NAME = "satvis.yaml";
/** The submodule's and any plugin's list of files under /data/models/ by NORAD id (ADR 0007). */
const MODEL_MANIFEST_NAME = "models.yaml";
const modelsManifestPath = path.join(repoRoot, "data", "models", MODEL_MANIFEST_NAME);
/** Pre-YAML plugin config name, detected only to fail loudly instead of dropping the plugin. */
const LEGACY_PLUGIN_CONFIG_NAME = "groups.json";

function readYaml(file) {
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Near-duplicate of parseTleText in src/modules/util/gp.ts with the opposite error
 * policy: this one throws so bad input never ships, the browser warns and skips. Do not unify them.
 */
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

/** `extraRecordsFile` resolves relative to the config's directory. */
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

/**
 * Without `git submodule update --init` (CI too) the submodule's manifest is missing:
 * warn, so lint and tests still run.
 */
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

/** A model's `file` is its path under /data/models/; the app adds the prefix. */
function modelAssignments(manifestPath) {
  const satellites = [];
  const buses = [];
  const source = path.relative(repoRoot, manifestPath);
  const dir = path.dirname(manifestPath);
  const { models } = readYaml(manifestPath) ?? {};
  if (!Array.isArray(models)) {
    throw new Error(`${source}: expected a top-level "models" list`);
  }
  models.forEach((model, i) => {
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
    for (const satellite of model.satellites ?? []) {
      if (!Number.isInteger(satellite?.noradId)) {
        throw new Error(`${source}: ${model.file} lists a satellite without a numeric noradId`);
      }
      satellites.push({ noradId: satellite.noradId, modelFile: model.file, origin: `${source} ${model.file}` });
    }
    if (model.buses !== undefined && !Array.isArray(model.buses)) {
      throw new Error(`${source}: ${model.file} has a "buses" that is not a list`);
    }
    for (const bus of model.buses ?? []) {
      if (!isGcatBusName(bus)) {
        throw new Error(`${source}: ${model.file} names bus ${JSON.stringify(bus)}, not spelled as GCAT's: trimmed, single spaces`);
      }
    }
    for (const bus of model.buses ?? []) {
      buses.push({ bus, modelFile: model.file, origin: `${source} ${model.file}` });
    }
  });
  return { satellites, buses };
}

function main() {
  const configs = [
    { path: coreConfigPath, config: loadConfig(coreConfigPath) },
    ...discoverPluginConfigs().map((configPath) => ({ path: configPath, config: loadConfig(configPath) })),
  ];

  const groups = configs.flatMap(({ config }) => config.groups);
  validateGroups(groups);
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
  const busAssignments = [];
  for (const manifestPath of discoverModelManifests()) {
    const { satellites, buses } = modelAssignments(manifestPath);
    for (const { noradId, modelFile, origin } of satellites) {
      table.add(noradId, { metadata: { modelFile } }, origin);
    }
    busAssignments.push(...buses);
  }
  const satellites = table.entries();
  const modelBuses = modelsByBus(busAssignments);

  const generated = { groups, presets, satellites, modelBuses };
  fs.writeFileSync(outPath, `${JSON.stringify(generated, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${path.relative(repoRoot, outPath)} (${groups.length} groups, ${presets.length} presets, ${satellites.length} satellites, ${Object.keys(modelBuses).length} model buses)\n`,
  );
}

main();
