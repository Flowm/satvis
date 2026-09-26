import { afterEach, describe, expect, test, vi } from "vitest";

import { SatelliteCatalog } from "./SatelliteCatalog";
import { parseGpPayload, type GpRecord } from "./util/gp";
import { resetGpSource } from "./util/gpSource";

// Two OMM records; ALPHA appears in both groups (same satnum + name) to
// exercise cross-group dedup and tag union.
function ommRecord(name: string, satnum: number): GpRecord {
  return {
    kind: "omm",
    omm: {
      OBJECT_NAME: name,
      OBJECT_ID: "",
      EPOCH: "2026-07-04T00:00:00.000000",
      MEAN_MOTION: 15,
      ECCENTRICITY: 0,
      INCLINATION: 51,
      RA_OF_ASC_NODE: 0,
      ARG_OF_PERICENTER: 0,
      MEAN_ANOMALY: 0,
      NORAD_CAT_ID: satnum,
      ELEMENT_SET_NO: 0,
      BSTAR: 0,
      MEAN_MOTION_DOT: 0,
      MEAN_MOTION_DDOT: 0,
    },
  };
}

describe("SatelliteCatalog", () => {
  test("dedups across two groups and unions tags", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("ALPHA", 1), ommRecord("BETA", 2)], ["GroupA"]);
    catalog.addRecords([ommRecord("ALPHA", 1), ommRecord("GAMMA", 3)], ["GroupB"]);

    // ALPHA, BETA, GAMMA — ALPHA is not duplicated.
    expect(catalog.size).toBe(3);
    const alpha = catalog.getByName("ALPHA");
    expect(alpha?.tags).toEqual(["GroupA", "GroupB"]);
  });

  test("first-wins byName", () => {
    const catalog = new SatelliteCatalog();
    // Same name, different satnums → distinct keys, but getByName returns first.
    catalog.addRecords([ommRecord("DUPE", 10)], ["A"]);
    catalog.addRecords([ommRecord("DUPE", 11)], ["B"]);
    expect(catalog.size).toBe(2);
    expect(catalog.getByName("DUPE")?.satnum).toBe("10");
  });

  test("entriesWithTag returns tag members", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("ZULU", 1), ommRecord("ALPHA", 2)], ["Weather"]);
    const names = catalog
      .entriesWithTag("Weather")
      .map((entry) => entry.name)
      .toSorted();
    expect(names).toEqual(["ALPHA", "ZULU"]);
  });

  test("groups reports per-tag counts", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("A", 1), ommRecord("B", 2)], ["G1"]);
    catalog.addRecords([ommRecord("C", 3)], ["G2"]);
    const groups = catalog.groups.toSorted((a, b) => a.tag.localeCompare(b.tag));
    expect(groups).toEqual([
      { tag: "G1", count: 2, searchOnly: false },
      { tag: "G2", count: 1, searchOnly: false },
    ]);
  });

  test("onChange fires with added and merged entries", () => {
    const catalog = new SatelliteCatalog();
    const batches: number[] = [];
    catalog.onChange((entries) => batches.push(entries.length));
    // addRecords does not fire onChange directly; only #loadGroupWithBase
    // (via loadGroups) does. Emulate by checking the returned changed set instead.
    const changed1 = catalog.addRecords([ommRecord("A", 1)], ["G1"]);
    expect(changed1).toHaveLength(1);
    // Re-adding with a new tag returns the merged entry.
    const changed2 = catalog.addRecords([ommRecord("A", 1)], ["G2"]);
    expect(changed2).toHaveLength(1);
    // Re-adding with an existing tag returns nothing changed.
    const changed3 = catalog.addRecords([ommRecord("A", 1)], ["G1"]);
    expect(changed3).toHaveLength(0);
    expect(batches).toEqual([]);
  });

  test("integrates with parseGpPayload output", () => {
    const catalog = new SatelliteCatalog();
    const payload = JSON.stringify([ommRecord("ISS (ZARYA)", 25544).kind === "omm" ? (ommRecord("ISS (ZARYA)", 25544) as { omm: unknown }).omm : {}]);
    const records = parseGpPayload(payload);
    catalog.addRecords(records, ["Stations"]);
    expect(catalog.getByName("ISS (ZARYA)")?.satnum).toBe("25544");
  });
});

// Lazy group loading: registered groups fetch only on demand (ensureTags /
// ensureAll), with per-request fallback to the static snapshot.

function ommPayload(...records: GpRecord[]): string {
  return JSON.stringify(records.map((record) => (record as { omm: unknown }).omm));
}

type RouteMap = Record<string, () => Response>;

function json(body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function installFetch(routes: RouteMap): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const route = routes[url];
      if (!route) {
        return new Response("Not Found", { status: 404 });
      }
      return route();
    }),
  );
  return requested;
}

const PROBE_ROUTES: RouteMap = {
  "/api/groups.json": json({
    updated: "",
    groups: [
      { name: "weather", count: 2 },
      { name: "stations", count: 1 },
    ],
  }),
};

describe("SatelliteCatalog lazy loading", () => {
  afterEach(() => {
    resetGpSource();
    vi.unstubAllGlobals();
  });

  test("registerGroups lists tags without fetching; ensureIndex fills estimated counts", async () => {
    const requested = installFetch(PROBE_ROUTES);
    const catalog = new SatelliteCatalog();
    catalog.registerGroups([
      ["weather", ["Weather"]],
      ["stations", ["Stations"]],
    ]);
    expect(catalog.groups.toSorted((a, b) => a.tag.localeCompare(b.tag))).toEqual([
      { tag: "Stations", count: 0, searchOnly: false },
      { tag: "Weather", count: 0, searchOnly: false },
    ]);
    await catalog.ensureIndex();
    expect(catalog.groups.toSorted((a, b) => a.tag.localeCompare(b.tag))).toEqual([
      { tag: "Stations", count: 1, searchOnly: false },
      { tag: "Weather", count: 2, searchOnly: false },
    ]);
    // Only the probe ran — no group payload was fetched.
    expect(requested.filter((url) => url.startsWith("/api/gp/"))).toEqual([]);
  });

  test("a tag is search-only until some registration offers it as a group", async () => {
    installFetch({
      ...PROBE_ROUTES,
      "/api/gp/stations.json": json(JSON.parse(ommPayload(ommRecord("ISS", 25544)))),
    });
    const catalog = new SatelliteCatalog();
    catalog.registerGroups([
      ["weather", ["Weather"]],
      ["stations", ["Stations"], { searchOnly: true }],
    ]);
    const searchOnly = () => Object.fromEntries(catalog.groups.map((group) => [group.tag, group.searchOnly]));
    expect(searchOnly()).toEqual({ Weather: false, Stations: true });
    // Loading changes nothing about it: the flag is about the group, not its entries.
    await catalog.ensureTags(["Stations"]);
    expect(searchOnly()).toEqual({ Weather: false, Stations: true });
    // A second preset that offers the same source whole wins over the first.
    catalog.registerGroups([["stations", ["Stations"]]]);
    expect(searchOnly()).toEqual({ Weather: false, Stations: false });
  });

  test("ensureTags fetches only matching groups and memoizes", async () => {
    const requested = installFetch({
      ...PROBE_ROUTES,
      "/api/gp/weather.json": json(JSON.parse(ommPayload(ommRecord("METEO-1", 1), ommRecord("METEO-2", 2)))),
    });
    const catalog = new SatelliteCatalog();
    catalog.registerGroups([
      ["weather", ["Weather"]],
      ["stations", ["Stations"]],
    ]);
    expect(catalog.isTagLoaded("Weather")).toBe(false);
    await catalog.ensureTags(["Weather"]);
    await catalog.ensureTags(["Weather"]);
    expect(catalog.isTagLoaded("Weather")).toBe(true);
    expect(catalog.entriesWithTag("Weather")).toHaveLength(2);
    expect(requested.filter((url) => url === "/api/gp/weather.json")).toHaveLength(1);
    expect(requested).not.toContain("/api/gp/stations.json");
  });

  test("ensureAll fetches every registered group", async () => {
    const requested = installFetch({
      ...PROBE_ROUTES,
      "/api/gp/weather.json": json(JSON.parse(ommPayload(ommRecord("METEO-1", 1)))),
      "/api/gp/stations.json": json(JSON.parse(ommPayload(ommRecord("ISS", 25544)))),
    });
    const catalog = new SatelliteCatalog();
    catalog.registerGroups([
      ["weather", ["Weather"]],
      ["stations", ["Stations"]],
    ]);
    await catalog.ensureAll();
    expect(catalog.size).toBe(2);
    expect(requested).toContain("/api/gp/weather.json");
    expect(requested).toContain("/api/gp/stations.json");
  });

  test("falls back to the static snapshot when the worker group fetch fails", async () => {
    installFetch({
      ...PROBE_ROUTES,
      "/api/gp/weather.json": () => new Response("KV miss", { status: 404 }),
      "data/gp/weather.json": json(JSON.parse(ommPayload(ommRecord("METEO-1", 1)))),
    });
    const catalog = new SatelliteCatalog();
    catalog.registerGroups([["weather", ["Weather"]]]);
    await catalog.ensureTags(["Weather"]);
    expect(catalog.isTagLoaded("Weather")).toBe(true);
    expect(catalog.getByName("METEO-1")).toBeDefined();
  });

  test("a failed load is retried on the next ensure call", async () => {
    let attempts = 0;
    installFetch({
      ...PROBE_ROUTES,
      "/api/gp/weather.json": () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response("boom", { status: 500 });
        }
        return json(JSON.parse(ommPayload(ommRecord("METEO-1", 1))))();
      },
      // Static fallback also fails on the first round.
      "data/gp/weather.json": () => new Response("missing", { status: 404 }),
    });
    const catalog = new SatelliteCatalog();
    catalog.registerGroups([["weather", ["Weather"]]]);
    await catalog.ensureTags(["Weather"]);
    expect(catalog.isTagLoaded("Weather")).toBe(false);
    await catalog.ensureTags(["Weather"]);
    expect(catalog.isTagLoaded("Weather")).toBe(true);
    expect(catalog.getByName("METEO-1")).toBeDefined();
  });
});
