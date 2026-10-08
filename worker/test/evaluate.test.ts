import { describe, expect, it } from "vitest";

import {
  buildStatuses,
  coerceIndex,
  collectSources,
  evaluateGroups,
  fetchSources,
  type GroupResult,
  type RecordsBySource,
  sourceKey,
  sourceUrl,
  toProbe,
  toRecordsBySource,
} from "../src/gp/evaluate.ts";
import type { GroupDefinition, GroupsIndex, OmmRecord } from "../src/gp/types.ts";

function omm(name: string, id: number): OmmRecord {
  return { OBJECT_NAME: name, NORAD_CAT_ID: id };
}

function group(result: GroupResult | Error | undefined): GroupResult {
  if (!result || result instanceof Error) {
    throw new Error(`expected records, got ${result}`);
  }
  return result;
}

function names(result: GroupResult | Error | undefined): string[] {
  return group(result).records.map((r) => r.OBJECT_NAME ?? "<unnamed>");
}

function warnings(result: GroupResult | Error | undefined): string[] {
  return group(result).warnings;
}

describe("sourceUrl / sourceKey", () => {
  it("builds celestrak group URLs", () => {
    expect(sourceUrl({ celestrak: "active" })).toBe("https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=JSON");
    expect(sourceKey({ celestrak: "active" })).toBe("celestrak:active");
  });
  it("builds celestrak supplemental URLs", () => {
    expect(sourceUrl({ celestrakSup: "transporter-12" })).toBe("https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=transporter-12&FORMAT=JSON");
    expect(sourceKey({ celestrakSup: "transporter-12" })).toBe("celestrakSup:transporter-12");
  });
  it("passes through raw URLs", () => {
    expect(sourceUrl({ url: "https://example.com/x.json" })).toBe("https://example.com/x.json");
    expect(sourceKey({ url: "https://example.com/x.json" })).toBe("url:https://example.com/x.json");
  });
});

describe("collectSources", () => {
  it("dedupes shared sources across groups", () => {
    const defs: GroupDefinition[] = [
      { name: "ot", sources: [{ celestrak: "active" }] },
      { name: "wfs", sources: [{ celestrak: "active" }] },
      { name: "move", sources: [{ celestrak: "active" }, { celestrak: "cubesat" }] },
    ];
    const sources = collectSources(defs);
    expect(sources.map(sourceKey).toSorted()).toEqual(["celestrak:active", "celestrak:cubesat"]);
  });
});

describe("evaluateGroups: select", () => {
  const records: RecordsBySource = new Map([
    ["celestrak:active", [omm("FIRST-MOVE", 39439), omm("MOVE-II", 43780), omm("LEMUR-2-ROHOVITHSA", 43547), omm("LEMUR-2-EMBRIONOVIS", 43556), omm("STARLINK-1", 44713)]],
  ]);

  it("selects by namePattern", () => {
    const defs: GroupDefinition[] = [{ name: "move", sources: [{ celestrak: "active" }], select: { namePattern: "^(FIRST-MOVE|MOVE-II)" } }];
    expect(names(evaluateGroups(defs, records).get("move"))).toEqual(["FIRST-MOVE", "MOVE-II"]);
  });

  it("selects by noradIds (string or number)", () => {
    const defs: GroupDefinition[] = [{ name: "ot", sources: [{ celestrak: "active" }], select: { noradIds: [43547, "43556"] } }];
    expect(names(evaluateGroups(defs, records).get("ot"))).toEqual(["LEMUR-2-ROHOVITHSA", "LEMUR-2-EMBRIONOVIS"]);
  });

  it("selects by names", () => {
    const defs: GroupDefinition[] = [{ name: "s", sources: [{ celestrak: "active" }], select: { names: ["STARLINK-1"] } }];
    expect(names(evaluateGroups(defs, records).get("s"))).toEqual(["STARLINK-1"]);
  });

  it("ORs the select criteria together", () => {
    const defs: GroupDefinition[] = [{ name: "mix", sources: [{ celestrak: "active" }], select: { noradIds: [44713], namePattern: "^FIRST-MOVE" } }];
    expect(names(evaluateGroups(defs, records).get("mix"))).toEqual(["FIRST-MOVE", "STARLINK-1"]);
  });

  it("passes all records through when no select is given", () => {
    const defs: GroupDefinition[] = [{ name: "all", sources: [{ celestrak: "active" }] }];
    expect(names(evaluateGroups(defs, records).get("all"))).toHaveLength(5);
  });
});

describe("evaluateGroups: rename", () => {
  it("renames matched OBJECT_NAME after select", () => {
    const records: RecordsBySource = new Map([["celestrak:active", [omm("LEMUR-2-ROHOVITHSA", 43547), omm("LEMUR-2-EMBRIONOVIS", 43556)]]]);
    const defs: GroupDefinition[] = [
      {
        name: "ot",
        sources: [{ celestrak: "active" }],
        select: { noradIds: [43547, 43556] },
        rename: { "LEMUR-2-ROHOVITHSA": "FOREST-1", "LEMUR-2-EMBRIONOVIS": "FOREST-2" },
      },
    ];
    expect(names(evaluateGroups(defs, records).get("ot"))).toEqual(["FOREST-1", "FOREST-2"]);
  });
});

describe("evaluateGroups: satellites rows", () => {
  const records: RecordsBySource = new Map([
    ["celestrak:active", [omm("LEMUR-2-ROHOVITHSA", 43547), omm("LEMUR-2-EMBRIONOVIS", 43556), omm("STARLINK-1", 44713), omm("GENA-OT", 66774)]],
  ]);

  it("selects a row by noradId", () => {
    const defs: GroupDefinition[] = [{ name: "ot", sources: [{ celestrak: "active" }], satellites: [{ noradId: 43547, upstreamName: "LEMUR-2-ROHOVITHSA", name: "FOREST-1" }] }];
    expect(names(evaluateGroups(defs, records).get("ot"))).toEqual(["FOREST-1"]);
  });

  it("selects a row by upstreamName fallback when noradId is absent", () => {
    const defs: GroupDefinition[] = [{ name: "ot", sources: [{ celestrak: "active" }], satellites: [{ upstreamName: "LEMUR-2-EMBRIONOVIS", name: "FOREST-2" }] }];
    expect(names(evaluateGroups(defs, records).get("ot"))).toEqual(["FOREST-2"]);
  });

  it("keeps the upstream name when a row omits `name`", () => {
    const defs: GroupDefinition[] = [{ name: "ot", sources: [{ celestrak: "active" }], satellites: [{ noradId: 66774, upstreamName: "GENA-OT" }] }];
    expect(names(evaluateGroups(defs, records).get("ot"))).toEqual(["GENA-OT"]);
  });

  it("applies the group rename map to a row-selected record with no row `name`", () => {
    const defs: GroupDefinition[] = [
      {
        name: "ot",
        sources: [{ celestrak: "active" }],
        satellites: [{ noradId: 66774, upstreamName: "GENA-OT" }],
        rename: { "GENA-OT": "GENA-1" },
      },
    ];
    expect(names(evaluateGroups(defs, records).get("ot"))).toEqual(["GENA-1"]);
  });

  it("unions satellites rows with `select`", () => {
    const defs: GroupDefinition[] = [
      {
        name: "ot",
        sources: [{ celestrak: "active" }],
        satellites: [{ noradId: 43547, upstreamName: "LEMUR-2-ROHOVITHSA", name: "FOREST-1" }],
        select: { names: ["STARLINK-1"] },
      },
    ];
    expect(names(evaluateGroups(defs, records).get("ot"))).toEqual(["FOREST-1", "STARLINK-1"]);
  });

  it("gives a row `name` precedence over the group rename map", () => {
    const defs: GroupDefinition[] = [
      {
        name: "ot",
        sources: [{ celestrak: "active" }],
        satellites: [{ noradId: 43547, upstreamName: "LEMUR-2-ROHOVITHSA", name: "FOREST-1" }],
        rename: { "LEMUR-2-ROHOVITHSA": "WRONG" },
      },
    ];
    expect(names(evaluateGroups(defs, records).get("ot"))).toEqual(["FOREST-1"]);
  });

  it("still applies the rename map to records not renamed by a row", () => {
    const defs: GroupDefinition[] = [
      {
        name: "ot",
        sources: [{ celestrak: "active" }],
        satellites: [{ noradId: 43547, upstreamName: "LEMUR-2-ROHOVITHSA", name: "FOREST-1" }],
        select: { names: ["LEMUR-2-EMBRIONOVIS"] },
        rename: { "LEMUR-2-EMBRIONOVIS": "FOREST-2" },
      },
    ];
    expect(names(evaluateGroups(defs, records).get("ot"))).toEqual(["FOREST-1", "FOREST-2"]);
  });

  it("warns when an id matches a record with an unexpected OBJECT_NAME", () => {
    const defs: GroupDefinition[] = [{ name: "ot", sources: [{ celestrak: "active" }], satellites: [{ noradId: 43547, upstreamName: "LEMUR-2-UNTITLED-SC", name: "FOREST-11" }] }];
    const result = evaluateGroups(defs, records).get("ot");
    expect(names(result)).toEqual(["FOREST-11"]);
    expect(warnings(result)).toEqual([`noradId 43547: expected OBJECT_NAME "LEMUR-2-UNTITLED-SC", got "LEMUR-2-ROHOVITHSA"`]);
  });

  it("warns when a row's noradId matches no record in the sources", () => {
    const defs: GroupDefinition[] = [{ name: "ot", sources: [{ celestrak: "active" }], satellites: [{ noradId: 99999, upstreamName: "GONE-SAT", name: "FOREST-99" }] }];
    const result = evaluateGroups(defs, records).get("ot");
    expect(names(result)).toEqual([]);
    expect(warnings(result)).toEqual([`noradId 99999: matched no record in the group's sources`]);
  });

  it("stays silent for a decayed row that matches nothing — the expected case", () => {
    const defs: GroupDefinition[] = [
      { name: "ot", sources: [{ celestrak: "active" }], satellites: [{ noradId: 51036, upstreamName: "LEMUR-2-ROHOVITHSA-OLD", name: "FOREST-1", decayed: true }] },
    ];
    const result = evaluateGroups(defs, records).get("ot");
    expect(names(result)).toEqual([]);
    expect(warnings(result)).toEqual([]);
  });

  it("warns in reverse when a decayed row unexpectedly matches", () => {
    const defs: GroupDefinition[] = [{ name: "ot", sources: [{ celestrak: "active" }], satellites: [{ noradId: 43547, name: "FOREST-1", decayed: true }] }];
    const result = evaluateGroups(defs, records).get("ot");
    expect(names(result)).toEqual(["FOREST-1"]);
    expect(warnings(result)).toEqual([`noradId 43547: marked decayed but matched a record`]);
  });

  it("does not warn for a name-only row that matches nothing (no id to track)", () => {
    const defs: GroupDefinition[] = [{ name: "ot", sources: [{ celestrak: "active" }], satellites: [{ upstreamName: "GONE-SAT", name: "FOREST-99" }] }];
    const result = evaluateGroups(defs, records).get("ot");
    expect(names(result)).toEqual([]);
    expect(warnings(result)).toEqual([]);
  });

  it("does not warn when both id and upstreamName match", () => {
    const defs: GroupDefinition[] = [{ name: "ot", sources: [{ celestrak: "active" }], satellites: [{ noradId: 43547, upstreamName: "LEMUR-2-ROHOVITHSA", name: "FOREST-1" }] }];
    expect(warnings(evaluateGroups(defs, records).get("ot"))).toEqual([]);
  });

  it("gives the lowest-index matching row the rename when a record matches both a name row and an id row", () => {
    // Rows 0 (name) and 1 (id) both match one record: row order, not selector kind,
    // decides the rename, and the record is emitted once.
    const defs: GroupDefinition[] = [
      {
        name: "ot",
        sources: [{ celestrak: "active" }],
        satellites: [
          { upstreamName: "LEMUR-2-ROHOVITHSA", name: "NAME-ROW-WINS" },
          { noradId: 43547, name: "ID-ROW-LOSES" },
        ],
      },
    ];
    expect(names(evaluateGroups(defs, records).get("ot"))).toEqual(["NAME-ROW-WINS"]);
  });
});

describe("evaluateGroups: include ordering (wfs-includes-ot)", () => {
  it("prepends included group output before own records, then extras", () => {
    const records: RecordsBySource = new Map([["celestrak:active", [omm("FOREST-SRC", 1), omm("SENTINEL-2A", 2), omm("NOAA 20 (JPSS-1)", 3)]]]);
    const defs: GroupDefinition[] = [
      { name: "wfs", sources: [{ celestrak: "active" }], select: { names: ["SENTINEL-2A", "NOAA 20 (JPSS-1)"] }, include: ["ot"] },
      {
        name: "ot",
        sources: [{ celestrak: "active" }],
        select: { noradIds: [1] },
        rename: { "FOREST-SRC": "FOREST-1" },
        extraRecords: [{ OBJECT_NAME: "OT-ADD-1", TLE_LINE1: "1 ...", TLE_LINE2: "2 ..." }],
      },
    ];
    const result = evaluateGroups(defs, records);
    // ot: own selected+renamed record, then its own extras.
    expect(names(result.get("ot"))).toEqual(["FOREST-1", "OT-ADD-1"]);
    // wfs: included ot output first (incl. ot's extras), then wfs' own records.
    expect(names(result.get("wfs"))).toEqual(["FOREST-1", "OT-ADD-1", "SENTINEL-2A", "NOAA 20 (JPSS-1)"]);
  });

  it("evaluates includes regardless of definition order", () => {
    const records: RecordsBySource = new Map([["celestrak:active", [omm("A", 1)]]]);
    // wfs listed before ot; topo order must still evaluate ot first.
    const defs: GroupDefinition[] = [
      { name: "wfs", include: ["ot"] },
      { name: "ot", sources: [{ celestrak: "active" }] },
    ];
    expect(names(evaluateGroups(defs, records).get("wfs"))).toEqual(["A"]);
  });
});

describe("evaluateGroups: exclude", () => {
  const active = [omm("STARLINK-1", 1), omm("STARLINK-2", 2), omm("ONEWEB-1", 3), omm("ISS", 25544)];

  it("removes the excluded groups' records by satnum, whatever the definition order", () => {
    const records: RecordsBySource = new Map([["celestrak:active", active]]);
    const defs: GroupDefinition[] = [
      { name: "active-remainder", sources: [{ celestrak: "active" }], exclude: ["starlink", "oneweb"] },
      { name: "starlink", sources: [{ celestrak: "active" }], select: { namePattern: "^STARLINK" } },
      { name: "oneweb", sources: [{ celestrak: "active" }], select: { namePattern: "^ONEWEB" } },
    ];
    expect(names(evaluateGroups(defs, records).get("active-remainder"))).toEqual(["ISS"]);
  });

  it("applies to includes and extras, matching pseudo-TLE satnums too", () => {
    const records: RecordsBySource = new Map([["celestrak:active", active]]);
    const defs: GroupDefinition[] = [
      {
        name: "rest",
        include: ["all"],
        exclude: ["gone"],
        extraRecords: [{ OBJECT_NAME: "PSEUDO", TLE_LINE1: "1 63351U ...", TLE_LINE2: "2 63351 ..." }],
      },
      { name: "all", sources: [{ celestrak: "active" }] },
      {
        name: "gone",
        sources: [{ celestrak: "active" }],
        select: { noradIds: [25544] },
        extraRecords: [{ OBJECT_NAME: "PSEUDO-TOO", TLE_LINE1: "1 63351U ...", TLE_LINE2: "2 63351 ..." }],
      },
    ];
    expect(names(evaluateGroups(defs, records).get("rest"))).toEqual(["STARLINK-1", "STARLINK-2", "ONEWEB-1"]);
  });

  it("fails when an excluded group failed, rather than serving the duplicates", () => {
    const records: RecordsBySource = new Map<string, OmmRecord[] | Error>([
      ["celestrak:active", active],
      ["celestrak:oneweb", new Error("HTTP 503")],
    ]);
    const defs: GroupDefinition[] = [
      { name: "active-remainder", sources: [{ celestrak: "active" }], exclude: ["oneweb"] },
      { name: "oneweb", sources: [{ celestrak: "oneweb" }] },
    ];
    const result = evaluateGroups(defs, records).get("active-remainder");
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("excluded group oneweb failed");
  });
});

describe("evaluateGroups: extraRecords", () => {
  it("appends extraRecords for source-less groups", () => {
    const defs: GroupDefinition[] = [
      {
        name: "otc",
        extraRecords: [
          { OBJECT_NAME: "OTC-P1-A", TLE_LINE1: "1 63351U ...", TLE_LINE2: "2 63351 ..." },
          { OBJECT_NAME: "OTC-P1-B", TLE_LINE1: "1 63352U ...", TLE_LINE2: "2 63352 ..." },
        ],
      },
    ];
    expect(names(evaluateGroups(defs, new Map()).get("otc"))).toEqual(["OTC-P1-A", "OTC-P1-B"]);
  });
});

describe("evaluateGroups: failure propagation", () => {
  it("evaluates a group with a failed source to an Error", () => {
    const records: RecordsBySource = new Map([["celestrak:active", new Error("HTTP 503")]]);
    const defs: GroupDefinition[] = [{ name: "weather", sources: [{ celestrak: "active" }] }];
    const result = evaluateGroups(defs, records).get("weather");
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("HTTP 503");
  });

  it("propagates a failed source through an include", () => {
    const records: RecordsBySource = new Map([["celestrak:active", new Error("boom")]]);
    const defs: GroupDefinition[] = [
      { name: "ot", sources: [{ celestrak: "active" }] },
      { name: "wfs", include: ["ot"], extraRecords: [{ TLE_LINE1: "1", TLE_LINE2: "2" }] },
    ];
    const result = evaluateGroups(defs, records);
    expect(result.get("ot")).toBeInstanceOf(Error);
    expect(result.get("wfs")).toBeInstanceOf(Error);
  });

  it("does not fail unrelated groups when one source fails", () => {
    const records: RecordsBySource = new Map<string, OmmRecord[] | Error>([
      ["celestrak:active", new Error("boom")],
      ["celestrak:weather", [omm("GOES 16", 41866)]],
    ]);
    const defs: GroupDefinition[] = [
      { name: "ot", sources: [{ celestrak: "active" }] },
      { name: "weather", sources: [{ celestrak: "weather" }] },
    ];
    const result = evaluateGroups(defs, records);
    expect(result.get("ot")).toBeInstanceOf(Error);
    expect(names(result.get("weather"))).toEqual(["GOES 16"]);
  });
});

describe("fetchSources validation", () => {
  const defs: GroupDefinition[] = [{ name: "g", sources: [{ celestrak: "active" }] }];

  async function records(fetchImpl: Parameters<typeof fetchSources>[1]): Promise<OmmRecord[] | Error | undefined> {
    return toRecordsBySource(await fetchSources(defs, fetchImpl)).get("celestrak:active");
  }

  it("accepts a valid OMM JSON array", async () => {
    expect(Array.isArray(await records(async () => ({ status: 200, text: async () => JSON.stringify([{ OBJECT_NAME: "X", NORAD_CAT_ID: 1 }]) })))).toBe(true);
  });

  it("rejects HTML error pages served with HTTP 200", async () => {
    expect(await records(async () => ({ status: 200, text: async () => "<html>error</html>" }))).toBeInstanceOf(Error);
  });

  it("rejects empty arrays", async () => {
    expect(await records(async () => ({ status: 200, text: async () => "[]" }))).toBeInstanceOf(Error);
  });

  it("rejects arrays whose first element lacks NORAD_CAT_ID", async () => {
    expect(await records(async () => ({ status: 200, text: async () => JSON.stringify([{ OBJECT_NAME: "X" }]) }))).toBeInstanceOf(Error);
  });

  it("rejects non-200 statuses", async () => {
    expect(await records(async () => ({ status: 404, text: async () => "[]" }))).toBeInstanceOf(Error);
  });
});

describe("fetchSources diagnostics", () => {
  const defs: GroupDefinition[] = [{ name: "g", sources: [{ celestrak: "active" }] }];

  it("returns per-source status, size, records and timing on success", async () => {
    const [r] = await fetchSources(defs, async () => ({ status: 200, text: async () => JSON.stringify([{ OBJECT_NAME: "X", NORAD_CAT_ID: 1 }]) }));
    expect(r?.key).toBe("celestrak:active");
    expect(r?.status).toBe(200);
    expect(r?.records).toHaveLength(1);
    expect(typeof r?.ms).toBe("number");
    const probe = toProbe(r!);
    expect(probe).toMatchObject({ key: "celestrak:active", ok: true, status: 200, records: 1, sample: "X" });
  });

  it("captures the status and a body sample on failure", async () => {
    const [r] = await fetchSources(defs, async () => ({ status: 522, text: async () => "<html>connection timed out</html>" }));
    expect(r?.records).toBeUndefined();
    expect(r?.error).toContain("HTTP 522");
    expect(r?.bodySample).toContain("connection timed out");
    expect(toProbe(r!)).toMatchObject({ ok: false, status: 522 });
  });
});

describe("coerceIndex", () => {
  it("passes a valid index through", () => {
    const index: GroupsIndex = { updated: "2026-07-01T00:00:00Z", groups: [{ name: "g", updated: "2026-07-01T00:00:00Z", count: 1 }] };
    expect(coerceIndex(index)).toBe(index);
  });

  it("falls back to an empty index for missing or corrupt values", () => {
    expect(coerceIndex(undefined)).toEqual({ updated: "", groups: [] });
    expect(coerceIndex(null)).toEqual({ updated: "", groups: [] });
    expect(coerceIndex("garbage")).toEqual({ updated: "", groups: [] });
    expect(coerceIndex({ groups: "not-an-array" })).toEqual({ updated: "", groups: [] });
  });
});

describe("buildStatuses", () => {
  const NOW = "2026-07-05T12:00:00Z";
  const BEFORE = "2026-07-05T09:00:00Z";
  const defs: GroupDefinition[] = [{ name: "ok" }, { name: "broken" }, { name: "new-broken" }];
  const previous: GroupsIndex = {
    updated: BEFORE,
    groups: [
      { name: "ok", updated: BEFORE, count: 1 },
      { name: "broken", updated: BEFORE, count: 5 },
    ],
  };

  it("reports fresh values for successful groups", () => {
    const evaluated = new Map<string, GroupResult | Error>([["ok", { records: [omm("A", 1), omm("B", 2)], warnings: [] }]]);
    const statuses = buildStatuses([{ name: "ok" }], evaluated, previous, NOW);
    expect(statuses).toEqual([{ name: "ok", updated: NOW, count: 2 }]);
  });

  it("preserves last-known-good for failed groups and records the error", () => {
    const evaluated = new Map<string, GroupResult | Error>([
      ["ok", { records: [omm("A", 1)], warnings: [] }],
      ["broken", new Error("upstream down")],
    ]);
    const statuses = buildStatuses(defs, evaluated, previous, NOW);
    expect(statuses).toEqual([
      { name: "ok", updated: NOW, count: 1 },
      { name: "broken", updated: BEFORE, count: 5, lastError: "upstream down", lastErrorAt: NOW },
      { name: "new-broken", updated: null, count: 0, lastError: "not evaluated", lastErrorAt: NOW },
    ]);
  });

  it("surfaces evaluation warnings on successful groups", () => {
    const evaluated = new Map<string, GroupResult | Error>([["ok", { records: [omm("A", 1)], warnings: ["noradId 999: matched no record in the group's sources"] }]]);
    const statuses = buildStatuses([{ name: "ok" }], evaluated, previous, NOW);
    expect(statuses).toEqual([{ name: "ok", updated: NOW, count: 1, warnings: ["noradId 999: matched no record in the group's sources"] }]);
  });
});
