import { describe, expect, it, vi } from "vitest";

import type { FetchImpl } from "../src/gp/evaluate.ts";
import { refreshGroups } from "../src/gp/refresh.ts";
import { SATCAT_URL } from "../src/gp/satcat.ts";
import type { GroupStore, GroupWriteMetadata } from "../src/gp/store.ts";
import type { GpRecord, GroupsConfig, GroupsIndex, OmmRecord, SatcatSnapshot } from "../src/gp/types.ts";

// The GroupStore contract of the KV and disk adapters, in memory.
function memoryStore(previous: GroupsIndex = { updated: "", groups: [] }, storedSatcat?: SatcatSnapshot) {
  const groups = new Map<string, { records: GpRecord[]; metadata: GroupWriteMetadata }>();
  let index: GroupsIndex | undefined;
  let satcat = storedSatcat;
  const store: GroupStore = {
    async readIndex() {
      return previous;
    },
    async writeGroup(name, records, metadata) {
      groups.set(name, { records, metadata });
    },
    async writeIndex(newIndex) {
      index = newIndex;
    },
    async readSatcat() {
      return satcat;
    },
    async writeSatcat(snapshot) {
      satcat = snapshot;
    },
  };
  return { store, groups, index: () => index, satcat: () => satcat };
}

const CONFIG: GroupsConfig = { groups: [{ name: "stations", sources: [{ celestrak: "stations" }] }] };

const SATCAT_HEADER =
  "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE";

// Two rows in CelesTrak's real column order and CRLF line endings: ISS, and the
// Nauka module docked to it.
const SATCAT_CSV = [
  SATCAT_HEADER,
  "ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.94,51.63,424,414,399.0524,,EA,ORB",
  "ISS (NAUKA),2021-066A,49044,PAY,+,CIS,2021-07-21,TYMSC,,92.94,51.63,424,414,,,25544,DOC",
].join("\r\n");

// Routed by URL, so the SATCAT fetch never gets a group payload. The catalog answers
// 304 by default, the production steady state.
function routedFetch(records: unknown[], satcat: Awaited<ReturnType<FetchImpl>>): FetchImpl {
  return async (url) => (url === SATCAT_URL ? satcat : { status: 200, text: async () => JSON.stringify(records) });
}

const notModified = { status: 304, text: async () => "" };

function okFetch(records: unknown[]): FetchImpl {
  return routedFetch(records, notModified);
}

const failingFetch: FetchImpl = async (url) => (url === SATCAT_URL ? notModified : { status: 500, text: async () => "upstream error" });

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

// What enrichment reads and what survives an unchanged or broken catalog; satcat.test.ts covers parsing.
describe("refreshGroups + satcat", () => {
  const RECORDS = [
    { OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: 25544 },
    { OBJECT_NAME: "ISS (NAUKA)", NORAD_CAT_ID: 49044 },
  ];

  const downloaded: Awaited<ReturnType<FetchImpl>> = {
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === "etag" ? '"abc123"' : null) },
    text: async () => SATCAT_CSV,
  };

  it("enriches every record from a freshly downloaded catalog, and stores it with its ETag", async () => {
    const { store, groups, index, satcat } = memoryStore();
    await refreshGroups(CONFIG, store, routedFetch(RECORDS, downloaded));

    const written = groups.get("stations")!.records as OmmRecord[];
    expect(written[0]!.metadata).toEqual({ owner: "ISS", launchDate: "1998-11-20", launchSite: "TYMSC", opsStatus: "+", orbitType: "ORB", orbitCenter: "EA" });
    // Nauka is docked, and SATCAT is the only thing that knows it.
    expect(written[1]!.metadata).toMatchObject({ orbitType: "DOC", orbitCenter: "25544" });

    expect(satcat()!.validator).toBe('"abc123"');
    expect(Object.keys(satcat()!.rows)).toEqual(["25544", "49044"]);
    expect(index()!.satcat).toMatchObject({ count: 2, validator: '"abc123"' });
  });

  it("sends the stored ETag and reuses the stored rows on a 304", async () => {
    const stored: SatcatSnapshot = {
      validator: '"abc123"',
      updated: "2026-07-01T00:00:00.000Z",
      rows: { "25544": { owner: "ISS", launchDate: "1998-11-20" } },
    };
    const seen: (string | undefined)[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      if (url !== SATCAT_URL) {
        return { status: 200, text: async () => JSON.stringify(RECORDS) };
      }
      seen.push(init?.headers?.["If-None-Match"]);
      return notModified;
    };

    const { store, groups, index } = memoryStore({ updated: "", groups: [] }, stored);
    await refreshGroups(CONFIG, store, fetchImpl);

    expect(seen).toEqual(['"abc123"']);
    const written = groups.get("stations")!.records as OmmRecord[];
    expect(written[0]!.metadata).toEqual({ owner: "ISS", launchDate: "1998-11-20" });
    // A 304 keeps `updated` at when the served rows were downloaded.
    expect(index()!.satcat).toMatchObject({ count: 1, updated: "2026-07-01T00:00:00.000Z" });
  });

  it("keeps enriching from the stored catalog when the fetch fails, and reports the error", async () => {
    const stored: SatcatSnapshot = { updated: "2026-07-01T00:00:00.000Z", rows: { "25544": { owner: "ISS" } } };
    const fetchImpl = routedFetch(RECORDS, { status: 503, text: async () => "" });

    const { store, groups, index } = memoryStore({ updated: "", groups: [] }, stored);
    const report = await refreshGroups(CONFIG, store, fetchImpl);

    // A SATCAT outage leaves the groups untouched.
    expect(report.written).toBe(1);
    expect(report.skipped).toBe(0);
    expect((groups.get("stations")!.records as OmmRecord[])[0]!.metadata).toEqual({ owner: "ISS" });
    expect(index()!.satcat).toMatchObject({ count: 1, lastError: "HTTP 503", updated: "2026-07-01T00:00:00.000Z" });
  });

  it("lets a curated field win over the catalog's without erasing the rest of the row", async () => {
    const config: GroupsConfig = {
      ...CONFIG,
      satellites: [{ noradId: 25544, name: "ISS", metadata: { owner: "INTERNATIONAL", swathStarboardKm: 205, swathPortKm: 205 } }],
    };
    const { store, groups } = memoryStore();
    await refreshGroups(config, store, routedFetch(RECORDS, downloaded));

    const written = groups.get("stations")!.records as OmmRecord[];
    expect(written[0]!.metadata).toEqual({
      owner: "INTERNATIONAL",
      swathStarboardKm: 205,
      swathPortKm: 205,
      launchDate: "1998-11-20",
      launchSite: "TYMSC",
      opsStatus: "+",
      orbitType: "ORB",
      orbitCenter: "EA",
    });
  });

  it("enriches nothing rather than failing when there is no catalog at all", async () => {
    const fetchImpl = routedFetch(RECORDS, { status: 503, text: async () => "" });
    const { store, groups, index } = memoryStore();
    const report = await refreshGroups(CONFIG, store, fetchImpl);

    expect(report.written).toBe(1);
    expect(groups.get("stations")!.records[0]).not.toHaveProperty("metadata");
    expect(index()!.satcat).toMatchObject({ count: 0, lastError: "HTTP 503" });
  });
});
