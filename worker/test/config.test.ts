// Checked on the generated file itself, so a generator regression cannot ship quietly.
import { describe, expect, it } from "vitest";

import generated from "../src/config/satvis.generated.json" with { type: "json" };
import type { GroupsConfig } from "../src/gp/types.ts";

const { groups, presets = [], satellites = [] } = generated as GroupsConfig;
const byName = new Map(groups.map((group) => [group.name, group]));

describe("the generated config", () => {
  // A remainder and the groups it excludes make up one whole, which one tag must load.
  it("tags the excluded groups with every tag of the group excluding them", () => {
    const remainders = groups.filter((group) => (group.exclude ?? []).length > 0);
    expect(remainders.length).toBeGreaterThan(0);
    for (const remainder of remainders) {
      for (const excluded of remainder.exclude ?? []) {
        expect(byName.get(excluded)?.tags, `${excluded} must carry the tags of ${remainder.name}`).toEqual(expect.arrayContaining(remainder.tags ?? []));
      }
    }
  });

  // The app puts it under ./data/models/, so it must not climb out of there.
  it("names every modelFile as a .glb path under /data/models/", () => {
    for (const { noradId, metadata } of satellites) {
      if (metadata.modelFile !== undefined) {
        expect(metadata.modelFile, `noradId ${noradId}`).toMatch(/^(?!\/)(?!.*\.\.).*\.glb$/);
      }
    }
  });

  // ADR 0007: the same rule as a listed satellite's modelFile.
  it("maps every model bus to a .glb path under /data/models/", () => {
    for (const [bus, modelFile] of Object.entries((generated as GroupsConfig).modelBuses ?? {})) {
      expect(bus.trim(), "a bus name").not.toBe("");
      expect(modelFile, bus).toMatch(/^(?!\/)(?!.*\.\.).*\.glb$/);
    }
  });

  it("has a default preset", () => {
    expect(presets.map((preset) => preset.name)).toContain("default");
  });

  it("registers only groups that exist and carry tags", () => {
    for (const preset of presets) {
      for (const { name } of preset.groups) {
        expect(byName.get(name)?.tags, `${preset.name}: ${name}`).toBeDefined();
      }
    }
  });
});
