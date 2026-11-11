import { describe, expect, it } from "vitest";

import { createSatelliteTable, validateGroups, validatePresets, validateRemainders, validateRemainderTags, validateSatelliteTable } from "../src/gp/configValidation.ts";

const SOURCES = [{ celestrak: "active" }];

describe("validateGroups", () => {
  it("accepts groups that include and exclude each other without a cycle", () => {
    expect(() => validateGroups([{ name: "a" }, { name: "b", include: ["a"] }, { name: "c", exclude: ["b"] }])).not.toThrow();
  });

  it("refuses a bad or duplicate name", () => {
    expect(() => validateGroups([{ name: "a b" }])).toThrow("invalid group name");
    expect(() => validateGroups([{ name: "a" }, { name: "a" }])).toThrow('duplicate group name "a"');
  });

  it("refuses an unknown or self dependency", () => {
    expect(() => validateGroups([{ name: "a", include: ["b"] }])).toThrow('group "a" includes unknown group "b"');
    expect(() => validateGroups([{ name: "a", exclude: ["a"] }])).toThrow('group "a" excludes itself');
  });

  it("names the cycle", () => {
    expect(() =>
      validateGroups([
        { name: "a", include: ["b"] },
        { name: "b", exclude: ["a"] },
      ]),
    ).toThrow("cycle detected: a -> b -> a");
  });

  it("refuses a key or a source kind the evaluator does not read", () => {
    expect(() => validateGroups([{ name: "a", rename: { X: "Y" } }])).toThrow('group "a": unknown key "rename"');
    expect(() => validateGroups([{ name: "a", select: { noradIds: [1] } }])).toThrow('group "a": unknown key "noradIds"');
    expect(() => validateGroups([{ name: "a", sources: [{ url: "https://example.com/x.json" }] }])).toThrow('group "a": a source must be');
    expect(() => validateGroups([{ name: "a", sources: SOURCES, select: { namePattern: "^A" }, tags: ["a"] }])).not.toThrow();
  });

  it("refuses a tag with a comma, which the url could not carry", () => {
    expect(() => validateGroups([{ name: "a", tags: ["x,y"] }])).toThrow("without a comma");
  });

  it("refuses half a swath and metadata without a NORAD id", () => {
    expect(() => validateGroups([{ name: "a", satellites: [{ noradId: 1, metadata: { swathPortKm: 10 } }] }])).toThrow("swath needs both");
    expect(() => validateGroups([{ name: "a", satellites: [{ upstreamName: "X", metadata: { missionType: "EO" } }] }])).toThrow('"metadata" requires a "noradId"');
    expect(() => validateGroups([{ name: "a", satellites: [{ noradId: 1, metadata: { model: { file: "a.glb" } } }] }])).toThrow('"model" is derived from "modelFile"');
    expect(() => validateSatelliteTable([{ noradId: 1, imagery: [] }], "core")).toThrow('"imagery" comes from the imagery manifest');
  });
});

describe("remainders", () => {
  it("must exclude every sibling selecting from the same sources", () => {
    const sibling = { name: "weather", sources: SOURCES, select: { namePattern: "^NOAA" } };
    expect(() => validateRemainders([sibling, { name: "rest", sources: SOURCES, exclude: [] }], "core")).toThrow('core: group "rest" must exclude "weather"');
    expect(() => validateRemainders([sibling, { name: "rest", sources: SOURCES, exclude: ["weather"] }], "core")).not.toThrow();
  });

  it("pass their tags on to the groups they exclude", () => {
    expect(() =>
      validateRemainderTags([
        { name: "weather", tags: ["eo"] },
        { name: "rest", tags: ["eo", "all"], exclude: ["weather"] },
      ]),
    ).toThrow('group "weather" must carry tag(s) "all"');
  });
});

describe("validatePresets", () => {
  const groups = [{ name: "weather", tags: ["eo"] }, { name: "untagged" }];

  it("normalizes bare group names and keeps searchOnly", () => {
    expect(validatePresets([{ name: "default", groups: ["weather", { name: "weather", searchOnly: true }] }], groups)).toEqual([
      { name: "default", groups: [{ name: "weather" }, { name: "weather", searchOnly: true }] },
    ]);
  });

  it("refuses an unknown or untagged group", () => {
    expect(() => validatePresets([{ name: "default", groups: ["nope"] }], groups)).toThrow('unknown group "nope"');
    expect(() => validatePresets([{ name: "default", groups: ["untagged"] }], groups)).toThrow('group "untagged" has no tags');
  });

  it("refuses a default tag none of its groups carries", () => {
    expect(() => validatePresets([{ name: "default", defaults: { tags: "sar" }, groups: ["weather"] }], groups)).toThrow('default tag "sar"');
  });

  it("gives a featured bookmark without a query an empty one, and serves no pictureAt", () => {
    const featured = [
      { name: "Weather", thumbnail: "showcase/weather.webp" },
      { name: "EO", thumbnail: "showcase/eo.webp", query: { tags: "eo", scene: "2D" }, pictureAt: "2026-10-04T08:52Z" },
    ];
    expect(validatePresets([{ name: "default", groups: ["weather"], featured }], groups)[0]!.featured).toEqual([
      { name: "Weather", thumbnail: "showcase/weather.webp", query: {} },
      { name: "EO", thumbnail: "showcase/eo.webp", query: { tags: "eo", scene: "2D" } },
    ]);
  });

  // No name or picture, a value the url could not carry, a tag none of its groups carries.
  it.each([
    [{ thumbnail: "a.jpg" }, '"name" must be a non-empty string'],
    [{ name: "A" }, '"thumbnail" must be a non-empty string'],
    [{ name: "A", thumbnail: "a.jpg", query: { scene: 2 } }, '"scene" must be a string'],
    [{ name: "A", thumbnail: "a.jpg", query: { tags: "eo,sar" } }, 'featured "A": tag "sar"'],
    [{ name: "A", thumbnail: "a.jpg", pictureAt: "at dawn" }, '"pictureAt" must be an ISO 8601 time'],
  ])("refuses the featured bookmark %j", (entry, message) => {
    expect(() => validatePresets([{ name: "default", groups: ["weather"], featured: [entry] }], groups)).toThrow(message);
  });

  it("serves each scene on its preset's route, and the default preset's to a preset with none", () => {
    const benchmark = [
      { id: "eo_points", name: "EO", query: { tags: "eo", elements: "Point" } },
      { id: "idle", name: "Idle", paced: true },
    ];
    const presets = validatePresets(
      [
        { name: "default", groups: ["weather"], benchmark },
        { name: "own", groups: ["weather"], benchmark: [{ id: "mine", name: "Mine" }] },
        { name: "none", groups: ["weather"] },
      ],
      groups,
    );
    const defaults = [
      { id: "eo_points", name: "EO", route: "/", query: { tags: "eo", elements: "Point" }, paced: false },
      { id: "idle", name: "Idle", route: "/", query: {}, paced: true },
    ];
    expect(presets.map((preset) => preset.benchmark)).toEqual([defaults, [{ id: "mine", name: "Mine", route: "/own", query: {}, paced: false }], defaults]);
  });

  it.each([
    [{ name: "A" }, '"id" must match'],
    [{ id: "Bad-id", name: "A" }, '"id" must match'],
    [{ id: "a" }, '"name" must be a non-empty string'],
    [{ id: "a", name: "A", query: { elements: ["Point"] } }, '"elements" must be a string'],
    [{ id: "a", name: "A", paced: "yes" }, '"paced" must be a boolean'],
    [{ id: "a", name: "A", query: { tags: "sar" } }, 'benchmark "a": tag "sar"'],
  ])("refuses the benchmark scene %j", (entry, message) => {
    expect(() => validatePresets([{ name: "default", groups: ["weather"], benchmark: [entry] }], groups)).toThrow(message);
  });

  it("refuses two benchmark scenes with one id", () => {
    const benchmark = [
      { id: "a", name: "A" },
      { id: "a", name: "B" },
    ];
    expect(() => validatePresets([{ name: "default", groups: ["weather"], benchmark }], groups)).toThrow('duplicate id "a"');
  });

  it("needs a default preset", () => {
    expect(() => validatePresets([{ name: "other", groups: ["weather"] }], groups)).toThrow('no "default" preset');
  });
});

describe("the satellite table", () => {
  it("merges identical facts and refuses conflicting ones, naming both origins", () => {
    const table = createSatelliteTable();
    table.add(5, { metadata: { missionType: "EO" }, name: "SAT" }, "core");
    table.add(5, { metadata: { missionType: "EO", modelFile: "a.glb" } }, "plugin");
    expect(table.entries()).toEqual([{ noradId: 5, name: "SAT", metadata: { missionType: "EO", modelFile: "a.glb" } }]);
    expect(() => table.add(5, { metadata: { modelFile: "b.glb" } }, "other")).toThrow('other sets modelFile="b.glb", but core, plugin set');
  });

  it("refuses a modelFile outside /data/models/, in a table entry or a group row", () => {
    expect(() => validateSatelliteTable([{ noradId: 5, modelFile: "../a.glb" }], "core")).toThrow('core satellites[0]: "modelFile" must be a .glb path');
    expect(() => validateGroups([{ name: "a", satellites: [{ noradId: 5, metadata: { modelFile: "/a.glb" } }] }])).toThrow('"modelFile" must be a .glb path');
    expect(() => validateSatelliteTable([{ noradId: 5, modelFile: "sats/a.glb" }], "core")).not.toThrow();
  });

  it("refuses an entry with nothing to attach", () => {
    expect(() => validateSatelliteTable([{ noradId: 5, name: "SAT" }], "core")).toThrow("core satellites[0]: has no metadata fields");
  });
});
