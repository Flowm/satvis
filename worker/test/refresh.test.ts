import { describe, expect, it, vi } from "vitest";

import type { FetchImpl } from "../src/gp/evaluate.ts";
import { GCAT_CATALOG, GCAT_ORGS, GCAT_PAYLOADS } from "../src/gp/gcat.ts";
import { refreshGroups, refreshUpstreams } from "../src/gp/refresh.ts";
import { SATCAT } from "../src/gp/satcat.ts";
import type { GroupsConfig, GroupsIndex, OmmRecord } from "../src/gp/types.ts";
import { storeUpstream } from "../src/gp/upstream.ts";
import { UPSTREAMS } from "../src/gp/upstreams.ts";
import { GCAT_CATALOG_LINES, GCAT_ORGS_LINES, GCAT_PAYLOADS_LINES, gcatCatalog, gcatOrgs, gcatPayloads } from "./gcatFixtures.ts";
import { memoryStore } from "./memoryStore.ts";

const CONFIG: GroupsConfig = { groups: [{ name: "stations", sources: [{ celestrak: "stations" }] }] };

const SATCAT_HEADER =
  "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE";

/**
 * Two rows in CelesTrak's real column order and CRLF line endings: ISS, and the
 * Nauka module docked to it.
 */
const SATCAT_CSV = [
  SATCAT_HEADER,
  "ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.94,51.63,424,414,399.0524,,EA,ORB",
  "ISS (NAUKA),2021-066A,49044,PAY,+,CIS,2021-07-21,TYMSC,,92.94,51.63,424,414,,,25544,DOC",
].join("\r\n");

const UPSTREAM_URLS = new Set(UPSTREAMS.map((spec) => spec.url));

/** A GP update reads the tables from the store; asking upstream for one fails the test. */
function okFetch(records: unknown[]): FetchImpl {
  return async (url) => {
    expect(UPSTREAM_URLS.has(url), `a GP update fetched ${url}`).toBe(false);
    return { status: 200, text: async () => JSON.stringify(records) };
  };
}

const failingFetch: FetchImpl = async () => ({ status: 500, text: async () => "upstream error" });

const NOW = "2026-10-07T00:00:00.000Z";

describe("refreshGroups", () => {
  it("writes evaluated groups and the rebuilt index through the store", async () => {
    const { store, groups, index } = memoryStore();
    const report = await refreshGroups(CONFIG, store, okFetch([{ OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: 25544 }]));

    expect(report.written).toBe(1);
    expect(report.skipped).toBe(0);

    const written = groups.get("stations");
    expect(written).toBeDefined();
    expect(written!.records).toHaveLength(1);
    expect(written!.metadata.count).toBe(1);
    expect(written!.metadata.updated).toBe(report.index.updated);

    expect(index()).toEqual(report.index);
    expect(report.index.groups).toEqual([expect.objectContaining({ name: "stations", count: 1, updated: report.index.updated })]);
  });

  // The static snapshot is served straight from disk, so its index carries the config's half.
  it("writes the config's tags and presets into the index", async () => {
    const { store, index } = memoryStore();
    const config: GroupsConfig = {
      groups: [{ name: "stations", sources: [{ celestrak: "stations" }], tags: ["Stations"] }],
      presets: [{ name: "default", defaults: { tags: "Stations" }, groups: [{ name: "stations" }] }],
    };
    await refreshGroups(config, store, okFetch([{ OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: 25544 }]));

    expect(index()!.groups[0]?.tags).toEqual(["Stations"]);
    expect(index()!.presets).toEqual({ default: { defaults: { tags: "Stations" }, groups: [{ name: "stations" }] } });
  });

  it("keeps last-known-good when a source fails: no write, index carries the old status", async () => {
    const previous: GroupsIndex = {
      updated: "2026-07-01T00:00:00.000Z",
      groups: [{ name: "stations", updated: "2026-07-01T00:00:00.000Z", count: 5 }],
    };
    const { store, groups, index } = memoryStore(previous);
    const report = await refreshGroups(CONFIG, store, failingFetch);

    expect(report.written).toBe(0);
    expect(report.skipped).toBe(1);
    expect(groups.size).toBe(0);

    const status = index()!.groups[0]!;
    expect(status.name).toBe("stations");
    expect(status.updated).toBe("2026-07-01T00:00:00.000Z");
    expect(status.count).toBe(5);
    expect(status.lastError).toBeTruthy();
  });

  it("attaches satellite-table metadata to the records it writes", async () => {
    const config: GroupsConfig = {
      ...CONFIG,
      satellites: [{ noradId: 25544, name: "ISS", metadata: { swathStarboardKm: 205, swathPortKm: 205 } }],
    };
    const { store, groups } = memoryStore();
    await refreshGroups(
      config,
      store,
      okFetch([
        { OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: 25544 },
        { OBJECT_NAME: "CSS (TIANHE)", NORAD_CAT_ID: 48274 },
      ]),
    );

    const written = groups.get("stations")!.records as OmmRecord[];
    expect(written[0]!.metadata).toEqual({ swathStarboardKm: 205, swathPortKm: 205 });
    // The frontend defaults unlisted satellites.
    expect(written[1]).not.toHaveProperty("metadata");
  });

  it("warns about a table entry that matched no record, but not about a decayed one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config: GroupsConfig = {
      ...CONFIG,
      satellites: [
        { noradId: 99999, name: "GONE", metadata: { coneFovDeg: 12 } },
        { noradId: 51036, name: "FOREST-1", decayed: true, metadata: { coneFovDeg: 12 } },
      ],
    };
    const { store } = memoryStore();
    await refreshGroups(config, store, okFetch([{ OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: 25544 }]));

    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes("99999") && m.includes("matched no record in any group"))).toBe(true);
    expect(messages.some((m) => m.includes("51036"))).toBe(false);
    warn.mockRestore();
  });
});

/** Stores all four tables from the fixtures, as push-catalog would. */
async function storeAll(store: Parameters<typeof storeUpstream>[1]): Promise<void> {
  await storeUpstream(SATCAT, store, SATCAT_CSV, undefined, NOW);
  await storeUpstream(GCAT_CATALOG, store, gcatCatalog(GCAT_CATALOG_LINES.ISS, GCAT_CATALOG_LINES.NAUKA), undefined, NOW);
  await storeUpstream(GCAT_ORGS, store, gcatOrgs(...Object.values(GCAT_ORGS_LINES)), undefined, NOW);
  await storeUpstream(GCAT_PAYLOADS, store, gcatPayloads(GCAT_PAYLOADS_LINES.ISS), undefined, NOW);
}

// What a GP update reads from the stored tables; upstream.test.ts covers storing them.
describe("refreshGroups + stored tables", () => {
  const RECORDS = [
    { OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: 25544 },
    { OBJECT_NAME: "ISS (NAUKA)", NORAD_CAT_ID: 49044 },
  ];

  it("joins every stored table into one bag per satellite, codes named", async () => {
    const { store, groups } = memoryStore();
    await storeAll(store);
    await refreshGroups(CONFIG, store, okFetch(RECORDS));

    const [iss, nauka] = groups.get("stations")!.records as OmmRecord[];
    expect(iss!.metadata).toEqual({
      launchDate: "1998-11-20",
      launchSite: "TYMSC",
      opsStatus: "+",
      orbitType: "ORB",
      orbitCenter: "EA",
      country: "USA",
      bus: "77KS",
      manufacturer: "KHRR",
      operator: "JSC",
      massKg: 20281,
      lengthM: 12.6,
      diameterM: 4.2,
      spanM: 23.9,
      shape: "Cyl + 2 Pan",
      estimated: ["diameterM"],
      category: "SS",
      class: "C",
    });
    // Nauka is docked, and SATCAT is the only thing that knows it.
    expect(nauka!.metadata).toMatchObject({ orbitType: "DOC", orbitCenter: "25544", country: "Russia", operator: "RKK Energiya" });
  });

  it("enriches from whichever tables are stored, and fails no group for a missing one", async () => {
    const { store, groups } = memoryStore();
    await storeUpstream(GCAT_CATALOG, store, gcatCatalog(GCAT_CATALOG_LINES.ISS), undefined, NOW);
    const report = await refreshGroups(CONFIG, store, okFetch(RECORDS));

    expect(report.written).toBe(1);
    // No organisations table, so the codes stay codes; no SATCAT, so no launch.
    expect((groups.get("stations")!.records as OmmRecord[])[0]!.metadata).toMatchObject({ country: "US", operator: "JSC" });
    expect((groups.get("stations")!.records as OmmRecord[])[0]!.metadata).not.toHaveProperty("launchDate");
  });

  it("enriches nothing rather than failing when no table is stored", async () => {
    const { store, groups } = memoryStore();
    const report = await refreshGroups(CONFIG, store, okFetch(RECORDS));

    expect(report.written).toBe(1);
    expect(groups.get("stations")!.records[0]).not.toHaveProperty("metadata");
  });

  it("lets a curated field win over a table's without erasing the rest of the row", async () => {
    const config: GroupsConfig = {
      ...CONFIG,
      satellites: [{ noradId: 25544, name: "ISS", metadata: { operator: "NASA and Roscosmos", swathStarboardKm: 205, swathPortKm: 205 } }],
    };
    const { store, groups } = memoryStore();
    await storeAll(store);
    await refreshGroups(config, store, okFetch(RECORDS));

    expect((groups.get("stations")!.records as OmmRecord[])[0]!.metadata).toMatchObject({
      operator: "NASA and Roscosmos",
      swathStarboardKm: 205,
      country: "USA",
      launchDate: "1998-11-20",
    });
  });
});

describe("refreshUpstreams", () => {
  it("asks for every table, each conditional on its own stored file", async () => {
    const { store } = memoryStore();
    await storeUpstream(SATCAT, store, SATCAT_CSV, '"abc"', NOW);
    const asked = new Map<string, string | undefined>();
    const statuses = await refreshUpstreams(store, async (url, init) => {
      asked.set(url, init?.headers?.["If-None-Match"]);
      return { status: 304, text: async () => "" };
    });

    expect([...asked.keys()]).toEqual(UPSTREAMS.map((spec) => spec.url));
    expect(asked.get(SATCAT.url)).toBe('"abc"');
    expect(asked.get(GCAT_CATALOG.url)).toBeUndefined();
    expect(Object.keys(statuses)).toEqual(["satcat", "gcat", "gcatOrgs", "gcatPayloads"]);
  });
});
