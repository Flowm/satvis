// A group that excludes others promises that together they make up the whole;
// a preset keeps that promise by tagging the pieces alike.
import { describe, expect, it } from "vitest";

import { presets } from "../../src/config/presets.ts";
import generated from "../src/config/satvis.generated.json" with { type: "json" };
import type { GroupDefinition } from "../src/gp/types.ts";

const groups = generated.groups as GroupDefinition[];

describe("presets against the served groups", () => {
  it("tags the excluded groups with every tag of the group excluding them", () => {
    const remainders = groups.filter((group) => (group.exclude ?? []).length > 0);
    expect(remainders.length).toBeGreaterThan(0);
    for (const [presetName, preset] of Object.entries(presets)) {
      const tagsOf = (source: string): string[] => preset.elements.filter(([name]) => name === source).flatMap(([, tags]) => tags);
      for (const remainder of remainders) {
        const tags = tagsOf(remainder.name);
        if (tags.length === 0) {
          // This preset does not serve the remainder, so it makes no promise about the whole.
          continue;
        }
        for (const excluded of remainder.exclude ?? []) {
          expect(tagsOf(excluded), `${presetName}: ${excluded} must carry the tags of ${remainder.name}`).toEqual(expect.arrayContaining(tags));
        }
      }
    }
  });
});
