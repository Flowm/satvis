// What the generated config promises its clients, checked on the generated file
// itself so that a regression in the generator cannot ship quietly.
import { describe, expect, it } from "vitest";

import generated from "../src/config/satvis.generated.json" with { type: "json" };
import type { GroupsConfig } from "../src/gp/types.ts";

const { groups, presets = [] } = generated as GroupsConfig;
const byName = new Map(groups.map((group) => [group.name, group]));

describe("the generated config", () => {
  // A group that excludes others promises that together they make up the whole,
  // and one tag has to load all of it.
  it("tags the excluded groups with every tag of the group excluding them", () => {
    const remainders = groups.filter((group) => (group.exclude ?? []).length > 0);
    expect(remainders.length).toBeGreaterThan(0);
    for (const remainder of remainders) {
      for (const excluded of remainder.exclude ?? []) {
        expect(byName.get(excluded)?.tags, `${excluded} must carry the tags of ${remainder.name}`).toEqual(expect.arrayContaining(remainder.tags ?? []));
      }
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
