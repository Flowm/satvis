import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import generatedConfig from "../src/config/satvis.generated.json" with { type: "json" };
import { collectSources, sourceKey, sourceUrl } from "../src/gp/evaluate.ts";
import { GCAT_CATALOG_URL } from "../src/gp/gcat.ts";
import { CATALOG_CRON, GP_CRON } from "../src/gp/schedule.ts";
import { kvGroupStore } from "../src/gp/store.ts";
import type { GroupsConfig, GroupsIndex, OmmRecord } from "../src/gp/types.ts";
import { UPSTREAMS } from "../src/gp/upstreams.ts";
import worker from "../src/index.ts";
import { GCAT_CATALOG_LINES, GCAT_ORGS_LINES, gcatCatalog, gcatOrgs } from "./gcatFixtures.ts";

/** Distinct upstream requests per refresh, asserted against the fetch spy after each test. */
const SOURCE_COUNT = collectSources((generatedConfig as GroupsConfig).groups).length;

const UPDATED = "2026-07-04T00:00:00.000Z";
const UPDATED_MS = Date.parse(UPDATED);

/**
 * Matches the REFRESH_TOKEN binding in vitest.config.ts. Secrets are absent from the
 * generated Env type, hence the local view, as in api.ts.
 */
const AUTH = { Authorization: "Bearer test-refresh-token" };
const secretEnv = env as typeof env & { REFRESH_TOKEN?: string };

function ommArray(...pairs: [string, number][]): OmmRecord[] {
  return pairs.map(([name, id]) => ({ OBJECT_NAME: name, NORAD_CAT_ID: id }));
}

/** The Worker's own store over the test KV, so no test knows its key layout. */
const store = () => kvGroupStore(env.GP_KV);

/** A stored group's records; null when none is stored. */
async function groupRecords(name: string): Promise<OmmRecord[] | null> {
  const group = await store().readGroup(name);
  return group === undefined ? null : (JSON.parse(group.body) as OmmRecord[]);
}

async function seedGroup(name: string, records: OmmRecord[], updated = UPDATED): Promise<void> {
  await store().writeGroup(name, records, { updated, count: records.length });
}

async function idsOf(group: string): Promise<unknown[]> {
  return (await groupRecords(group))!.map((r) => r.NORAD_CAT_ID);
}

/** Built like scripts/push-gp.mjs builds it: bundleFetch matches on the sourceUrl() url. */
function ingestBundle(reply: (source: string) => unknown, opts?: { status?: number }): string {
  const specs = collectSources((generatedConfig as GroupsConfig).groups);
  return JSON.stringify({
    fetchedAt: UPDATED,
    sources: specs.map((spec) => {
      const url = sourceUrl(spec);
      const params = new URL(url).searchParams;
      const source = params.get("GROUP") ?? params.get("FILE") ?? "";
      return { key: sourceKey(spec), url, status: opts?.status ?? 200, body: JSON.stringify(reply(source)) };
    }),
  });
}

function postIngest(body: string, headers: Record<string, string> = AUTH): Promise<Response> {
  return SELF.fetch("https://satvis.space/api/ingest", { method: "POST", headers, body });
}

/** As push-catalog uploads a downloaded table. */
function putTable(name: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`https://satvis.space/api/upstream/${name}`, { method: "PUT", headers: { ...AUTH, ...headers }, body });
}

/** As push-catalog reports a 304 or a failure: no body, a header saying which. */
function reportTable(name: string, headers: Record<string, string>): Promise<Response> {
  return SELF.fetch(`https://satvis.space/api/upstream/${name}`, { method: "PUT", headers: { ...AUTH, ...headers } });
}

interface StatusBody {
  stale: boolean;
  built: string | null;
  sources: Record<string, { updated?: string; checked?: string; etag?: string; rows?: number; lastError?: string; stored: boolean; stale: boolean }>;
  groups: { name: string; updated: string | null; stale: boolean }[];
}

/** Storage persists across this file's tests, so a test that needs an empty store starts here. */
async function clearStore(): Promise<void> {
  const { keys } = await env.GP_KV.list();
  await Promise.all(keys.map(({ name }) => env.GP_KV.delete(name)));
}

/** GET /api/status, parsed. */
async function status(): Promise<StatusBody> {
  return (await (await SELF.fetch("https://satvis.space/api/status")).json()) as StatusBody;
}

describe("GET /api/gp/<group>.json", () => {
  beforeEach(async () => {
    await seedGroup("weather", ommArray(["GOES 16", 41866], ["NOAA 20 (JPSS-1)", 43013]));
  });

  it("serves records with caching headers", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/weather.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.headers.get("ETag")).toBe(`W/"weather-${UPDATED_MS}"`);
    expect(res.headers.get("Last-Modified")).toBe(new Date(UPDATED_MS).toUTCString());
    const body = (await res.json()) as OmmRecord[];
    expect(body.map((r) => r.OBJECT_NAME)).toEqual(["GOES 16", "NOAA 20 (JPSS-1)"]);
  });

  it("returns 304 for matching If-None-Match", async () => {
    const etag = `W/"weather-${UPDATED_MS}"`;
    const res = await SELF.fetch("https://satvis.space/api/gp/weather.json", { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(await res.text()).toBe("");
  });

  it("returns 200 (not 304) for a stale If-None-Match", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/weather.json", { headers: { "If-None-Match": 'W/"weather-1"' } });
    expect(res.status).toBe(200);
  });

  it("404s an unknown group", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/nonesuch.json");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("404s an invalid group name", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/..%2Fsecret.json");
    expect(res.status).toBe(404);
  });

  it("404s malformed percent-encoding (not 500)", async () => {
    const res = await SELF.fetch("https://satvis.space/api/gp/%zz.json");
    expect(res.status).toBe(404);
  });
});

describe("index route", () => {
  it("serves gp:index at /api/groups.json", async () => {
    const index: GroupsIndex = { updated: UPDATED, groups: [{ name: "weather", updated: UPDATED, count: 2 }] };
    await store().writeIndex(index);
    const res = await SELF.fetch("https://satvis.space/api/groups.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupsIndex;
    expect(body.updated).toBe(UPDATED);
    expect(body.groups.find((group) => group.name === "weather")).toMatchObject({ updated: UPDATED, count: 2 });
  });

  // The config's half is the deployed one, whatever the last refresh wrote.
  it("lays the deployed tags and presets over the stored index", async () => {
    const index: GroupsIndex = { updated: UPDATED, groups: [{ name: "weather", updated: UPDATED, count: 2, tags: ["Stale"] }] };
    await store().writeIndex(index);
    const body = (await (await SELF.fetch("https://satvis.space/api/groups.json")).json()) as GroupsIndex;
    expect(body.groups.map((group) => group.name)).toEqual((generatedConfig as GroupsConfig).groups.map((group) => group.name));
    expect(body.groups.find((group) => group.name === "weather")?.tags).toEqual(["Weather"]);
    expect(body.groups.find((group) => group.name === "starlink")).toMatchObject({ updated: null, count: 0, tags: ["Starlink", "Active"] });
    expect(body.presets?.default).toMatchObject({ defaults: { tags: "Weather" } });
    expect(body.presets?.default?.groups).toContainEqual({ name: "weather" });
  });

  it("serves the config's half when no index is stored", async () => {
    await clearStore();
    const res = await SELF.fetch("https://satvis.space/api/groups.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupsIndex;
    expect(body.updated).toBe("");
    expect(body.groups.every((group) => group.updated === null && group.count === 0)).toBe(true);
    expect(body.presets?.default).toBeDefined();
  });

  it("answers a matching If-None-Match with a 304, and a refresh changes the ETag", async () => {
    await store().writeIndex({ updated: UPDATED, groups: [] } satisfies GroupsIndex);
    const first = await SELF.fetch("https://satvis.space/api/groups.json");
    const etag = first.headers.get("ETag");
    expect(etag).toMatch(/^W\/"groups-[0-9a-f]{8}"$/);
    await first.arrayBuffer();

    const again = await SELF.fetch("https://satvis.space/api/groups.json", { headers: { "If-None-Match": etag! } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");

    await store().writeIndex({ updated: "2026-07-05T00:00:00.000Z", groups: [] } satisfies GroupsIndex);
    const refreshed = await SELF.fetch("https://satvis.space/api/groups.json", { headers: { "If-None-Match": etag! } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("ETag")).not.toBe(etag);
    await refreshed.arrayBuffer();
  });

  // Records carry their metadata; there is no metadata endpoint.
  it("404s the retired /api/metadata.json", async () => {
    const res = await SELF.fetch("https://satvis.space/api/metadata.json");
    expect(res.status).toBe(404);
  });

  it("404s an unknown /api/* path", async () => {
    const res = await SELF.fetch("https://satvis.space/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("scheduled() refresh", () => {
  // refreshAll uses the global fetch. The default stub rejects every request;
  // interceptCelestrak() swaps in a reply and sets the expected call count.
  let fetchSpy: MockInstance<typeof fetch>;
  let expectedFetches = 0;

  beforeEach(() => {
    expectedFetches = 0;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      throw new Error(`unmocked fetch: ${new Request(input, init).url}`);
    });
  });
  // An exact count makes a missing or extra fetch fail the test that caused it.
  afterEach(() => {
    expect(fetchSpy).toHaveBeenCalledTimes(expectedFetches);
    vi.restoreAllMocks();
  });

  /**
   * Answers gp.php and sup-gp.php requests synthetically. A GP refresh asks for nothing
   * else: it reads the upstream tables from KV.
   */
  function interceptCelestrak(reply: (group: string) => unknown, opts?: { status?: number }): void {
    expectedFetches = SOURCE_COUNT;
    fetchSpy.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const isGp = url.pathname === "/NORAD/elements/gp.php" || url.pathname === "/NORAD/elements/supplemental/sup-gp.php";
      if (request.method !== "GET" || url.origin !== "https://celestrak.org" || !isGp) {
        throw new Error(`unmocked fetch: ${request.method} ${request.url}`);
      }
      const source = url.searchParams.get("GROUP") ?? url.searchParams.get("FILE") ?? "";
      return new Response(JSON.stringify(reply(source)), { status: opts?.status ?? 200 });
    });
  }

  it("writes evaluated groups to KV and builds the index", async () => {
    interceptCelestrak((group) => [{ OBJECT_NAME: `${group.toUpperCase()}-1`, NORAD_CAT_ID: 10000 + group.length }]);

    const ctx = createExecutionContext();
    const controller = createScheduledController({ scheduledTime: Date.now(), cron: GP_CRON });
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const weather = await groupRecords("weather");
    expect(Array.isArray(weather)).toBe(true);

    const index = await store().readIndex();
    const weatherStatus = index.groups.find((g) => g.name === "weather");
    expect(weatherStatus?.count).toBeGreaterThan(0);
    expect(weatherStatus?.lastError).toBeUndefined();
    // The example `iss` group's row (noradId 25544) matches no synthetic record, so
    // its warning must surface in the index.
    const issStatus = index.groups.find((g) => g.name === "iss");
    expect(issStatus).toBeDefined();
    expect(issStatus?.lastError).toBeUndefined();
    expect(issStatus?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("matched no record")]));
  });

  it("carves the derived groups out of the shared active source", async () => {
    // Each record lands in exactly one group, the anchored patterns skip names that
    // merely contain a prefix, and `satellites` rows (real ids) pull in the unprefixed members.
    interceptCelestrak((source) =>
      source === "active"
        ? [
            { OBJECT_NAME: "STARLINK-1234", NORAD_CAT_ID: 1 },
            { OBJECT_NAME: "ONEWEB-0042", NORAD_CAT_ID: 2 },
            { OBJECT_NAME: "GLOBALSTAR M001", NORAD_CAT_ID: 3 },
            { OBJECT_NAME: "IRIDIUM 100", NORAD_CAT_ID: 4 },
            { OBJECT_NAME: "FLOCK 4X-1", NORAD_CAT_ID: 5 },
            { OBJECT_NAME: "PELICAN-11", NORAD_CAT_ID: 6 },
            { OBJECT_NAME: "LEMUR-2-CLARA", NORAD_CAT_ID: 7 },
            { OBJECT_NAME: "EUTELSAT 7C", NORAD_CAT_ID: 8 },
            { OBJECT_NAME: "OTTER SDM", NORAD_CAT_ID: 66678 },
            { OBJECT_NAME: "EXPRESS-AT1", NORAD_CAT_ID: 39612 },
            { OBJECT_NAME: "NOT-STARLINK-9", NORAD_CAT_ID: 90 },
            { OBJECT_NAME: "COSMOS 2251", NORAD_CAT_ID: 91 },
          ]
        : [{ OBJECT_NAME: `${source.toUpperCase()}-1`, NORAD_CAT_ID: 900 }],
    );

    const ctx = createExecutionContext();
    const controller = createScheduledController({ scheduledTime: Date.now(), cron: GP_CRON });
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await idsOf("starlink")).toEqual([1]);
    expect(await idsOf("oneweb")).toEqual([2]);
    expect(await idsOf("globalstar")).toEqual([3]);
    expect(await idsOf("iridium-NEXT")).toEqual([4]);
    expect(await idsOf("planet")).toEqual([5, 6]);
    expect(await idsOf("spire")).toEqual([7, 66678]);
    expect(await idsOf("eutelsat")).toEqual([8, 39612]);
  });

  it("preserves last-known-good on failure", async () => {
    await seedGroup("weather", ommArray(["GOOD SAT", 1]), "2026-01-01T00:00:00.000Z");
    await store().writeIndex({ updated: "2026-01-01T00:00:00.000Z", groups: [{ name: "weather", updated: "2026-01-01T00:00:00.000Z", count: 1 }] } satisfies GroupsIndex);

    interceptCelestrak(() => [], { status: 503 });

    const ctx = createExecutionContext();
    const controller = createScheduledController({ scheduledTime: Date.now(), cron: GP_CRON });
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const weather = (await groupRecords("weather"))!;
    expect(weather.map((r) => r.OBJECT_NAME)).toEqual(["GOOD SAT"]);

    const index = await store().readIndex();
    const weatherStatus = index.groups.find((g) => g.name === "weather");
    expect(weatherStatus?.updated).toBe("2026-01-01T00:00:00.000Z");
    expect(weatherStatus?.lastError).toBeTruthy();
    expect(weatherStatus?.lastErrorAt).toBeTruthy();
  });

  it("runs the refresh and reports per-source diagnostics on POST /api/refresh", async () => {
    // An old index is past the cooldown.
    await store().writeIndex({ updated: "2020-01-01T00:00:00.000Z", groups: [] } satisfies GroupsIndex);
    interceptCelestrak((group) => [{ OBJECT_NAME: `${group.toUpperCase()}-1`, NORAD_CAT_ID: 42 }]);

    const res = await SELF.fetch("https://satvis.space/api/refresh", { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = (await res.json()) as {
      refreshed: boolean;
      written: number;
      sources: { key: string; ok: boolean; status?: number; records?: number }[];
      groups: { name: string }[];
    };
    expect(body.refreshed).toBe(true);
    expect(body.written).toBeGreaterThan(0);
    expect(body.sources).toHaveLength(SOURCE_COUNT);
    expect(body.sources.every((s) => s.ok && s.status === 200 && (s.records ?? 0) > 0)).toBe(true);
    expect(Array.isArray(await groupRecords("weather"))).toBe(true);
  });

  it("rate-limits POST /api/refresh within the cooldown and returns the cached index", async () => {
    // Without interceptCelestrak(), the afterEach count proves no upstream fetch was made.
    const recent = new Date().toISOString();
    await store().writeIndex({
      updated: recent,
      groups: [{ name: "weather", updated: recent, count: 2, lastError: "source celestrak:weather failed: HTTP 522" }],
    } satisfies GroupsIndex);

    const res = await SELF.fetch("https://satvis.space/api/refresh", { method: "POST", headers: AUTH });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await res.json()) as { refreshed: boolean; reason: string; retryAfterMs: number; groups: { name: string; lastError?: string }[] };
    expect(body.refreshed).toBe(false);
    expect(body.reason).toBe("cooldown");
    expect(body.retryAfterMs).toBeGreaterThan(0);
    expect(body.groups.find((g) => g.name === "weather")?.lastError).toContain("HTTP 522");
  });

  it("rejects a non-POST /api/refresh with 405", async () => {
    const res = await SELF.fetch("https://satvis.space/api/refresh");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  // The afterEach count (0) proves the token protects CelesTrak, not just the response.
  it.each([
    ["no Authorization header", {}],
    ["a wrong token", { Authorization: "Bearer not-the-token" }],
  ])("rejects POST /api/refresh with %s", async (_label, headers) => {
    const res = await SELF.fetch("https://satvis.space/api/refresh", { method: "POST", headers });
    expect(res.status).toBe(401);
  });

  it("fails closed with 503 when REFRESH_TOKEN is not configured", async () => {
    const configured = secretEnv.REFRESH_TOKEN;
    delete secretEnv.REFRESH_TOKEN;
    try {
      const res = await SELF.fetch("https://satvis.space/api/refresh", { method: "POST", headers: AUTH });
      expect(res.status).toBe(503);
    } finally {
      secretEnv.REFRESH_TOKEN = configured;
    }
  });
});

describe("POST /api/ingest", () => {
  // Every test asserts the Worker made no upstream request.
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      throw new Error(`unmocked fetch: ${new Request(input, init).url}`);
    });
  });
  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("writes evaluated groups to KV without touching the network", async () => {
    const res = await postIngest(ingestBundle((source) => [{ OBJECT_NAME: `${source.toUpperCase()}-1`, NORAD_CAT_ID: 10000 + source.length }]));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = (await res.json()) as { ingested: boolean; written: number; sources: { ok: boolean; records?: number }[] };
    expect(body.ingested).toBe(true);
    expect(body.written).toBeGreaterThan(0);
    expect(body.sources).toHaveLength(SOURCE_COUNT);
    expect(body.sources.every((s) => s.ok && (s.records ?? 0) > 0)).toBe(true);

    const index = await store().readIndex();
    expect(index.groups.find((g) => g.name === "weather")?.lastError).toBeUndefined();
    expect(Array.isArray(await groupRecords("weather"))).toBe(true);
  });

  it("carves the derived groups out of the ingested active source", async () => {
    // The same carve-out assertions as the scheduled() test.
    await postIngest(
      ingestBundle((source) =>
        source === "active"
          ? [
              { OBJECT_NAME: "STARLINK-1234", NORAD_CAT_ID: 1 },
              { OBJECT_NAME: "ONEWEB-0042", NORAD_CAT_ID: 2 },
              { OBJECT_NAME: "LEMUR-2-CLARA", NORAD_CAT_ID: 7 },
              { OBJECT_NAME: "OTTER SDM", NORAD_CAT_ID: 66678 },
              { OBJECT_NAME: "NOT-STARLINK-9", NORAD_CAT_ID: 90 },
            ]
          : [{ OBJECT_NAME: `${source.toUpperCase()}-1`, NORAD_CAT_ID: 900 }],
      ),
    );

    expect(await idsOf("starlink")).toEqual([1]);
    expect(await idsOf("oneweb")).toEqual([2]);
    expect(await idsOf("spire")).toEqual([7, 66678]);
  });

  it("preserves last-known-good for a source the downloader could not fetch", async () => {
    await seedGroup("weather", ommArray(["GOOD SAT", 1]), "2026-01-01T00:00:00.000Z");
    await store().writeIndex({ updated: "2026-01-01T00:00:00.000Z", groups: [{ name: "weather", updated: "2026-01-01T00:00:00.000Z", count: 1 }] } satisfies GroupsIndex);

    // Replace the weather source with the failure shape push-gp.mjs sends.
    const parsed = JSON.parse(ingestBundle(() => [{ OBJECT_NAME: "SAT", NORAD_CAT_ID: 5 }])) as {
      sources: { key: string; body?: string; error?: string; status?: number }[];
    };
    for (const source of parsed.sources) {
      if (source.key === "celestrak:weather") {
        delete source.body;
        source.error = "HTTP 522";
      }
    }

    const res = await postIngest(JSON.stringify(parsed));
    expect(res.status).toBe(200);

    // The value survives, and the index carries the downloader's own message.
    const weather = (await groupRecords("weather"))!;
    expect(weather.map((r) => r.OBJECT_NAME)).toEqual(["GOOD SAT"]);
    const index = await store().readIndex();
    const weatherStatus = index.groups.find((g) => g.name === "weather");
    expect(weatherStatus?.updated).toBe("2026-01-01T00:00:00.000Z");
    expect(weatherStatus?.lastError).toContain("HTTP 522");
  });

  it("rejects a payload that is not a valid OMM array, keeping last-known-good", async () => {
    // The Worker re-validates rather than trusting the bundle, so a mangled body
    // fails the group instead of replacing good records with junk.
    await seedGroup("weather", ommArray(["GOOD SAT", 1]), "2026-01-01T00:00:00.000Z");

    const res = await postIngest(ingestBundle(() => ({ not: "an array" })));
    expect(res.status).toBe(200);

    const weather = (await groupRecords("weather"))!;
    expect(weather.map((r) => r.OBJECT_NAME)).toEqual(["GOOD SAT"]);
    const body = (await res.json()) as { written: number; skipped: number };
    expect(body.written).toBe(0);
    expect(body.skipped).toBeGreaterThan(0);
  });

  it("fails a group whose source is missing from the bundle", async () => {
    const parsed = JSON.parse(ingestBundle(() => [{ OBJECT_NAME: "SAT", NORAD_CAT_ID: 5 }])) as { sources: { key: string }[] };
    parsed.sources = parsed.sources.filter((source) => source.key !== "celestrak:weather");

    const res = await postIngest(JSON.stringify(parsed));
    const body = (await res.json()) as { groups: { name: string; lastError?: string }[] };
    expect(body.groups.find((g) => g.name === "weather")?.lastError).toContain("absent from the ingest bundle");
  });

  it("enriches from the stored tables, which the bundle no longer carries", async () => {
    await clearStore();
    // The ISS's GCAT row, renumbered onto a record the bundle serves.
    await putTable("gcat", gcatCatalog(GCAT_CATALOG_LINES.ISS.replace("\t25544\t", "\t10007\t")));
    await putTable("gcatOrgs", gcatOrgs(...Object.values(GCAT_ORGS_LINES)));

    const res = await postIngest(ingestBundle((source) => [{ OBJECT_NAME: `${source.toUpperCase()}-1`, NORAD_CAT_ID: 10000 + source.length }]));
    expect(res.status).toBe(200);
    const weather = (await groupRecords("weather"))!;
    expect(weather.find((r) => r.NORAD_CAT_ID === 10007)?.metadata).toMatchObject({ country: "USA", bus: "77KS", massKg: 20281 });
  });

  it.each([
    ["a non-JSON body", "not json", "body is not valid JSON"],
    ["a missing sources array", JSON.stringify({}), "body.sources must be an array"],
    ["an empty sources array", JSON.stringify({ sources: [] }), "body.sources is empty"],
    ["an entry without key/url", JSON.stringify({ sources: [{ body: "[]" }] }), "needs string key and url"],
    ["an entry with neither body nor error", JSON.stringify({ sources: [{ key: "k", url: "u" }] }), "needs either body or error"],
  ])("400s %s", async (_label, body, expected) => {
    const res = await postIngest(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(expected);
  });

  it("rejects a non-POST /api/ingest with 405", async () => {
    const res = await SELF.fetch("https://satvis.space/api/ingest");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  // The token gates the write before the body is parsed.
  it.each([
    ["no Authorization header", {}],
    ["a wrong token", { Authorization: "Bearer not-the-token" }],
  ])("rejects POST /api/ingest with %s", async (_label, headers) => {
    await seedGroup("weather", ommArray(["GOOD SAT", 1]));
    const res = await postIngest(
      ingestBundle(() => [{ OBJECT_NAME: "EVIL SAT", NORAD_CAT_ID: 666 }]),
      headers as Record<string, string>,
    );
    expect(res.status).toBe(401);
    expect((await idsOf("weather")).length).toBe(1);
  });

  it("fails closed with 503 when REFRESH_TOKEN is not configured", async () => {
    const configured = secretEnv.REFRESH_TOKEN;
    delete secretEnv.REFRESH_TOKEN;
    try {
      const res = await postIngest(ingestBundle(() => [{ OBJECT_NAME: "SAT", NORAD_CAT_ID: 5 }]));
      expect(res.status).toBe(503);
    } finally {
      secretEnv.REFRESH_TOKEN = configured;
    }
  });
});

describe("PUT /api/upstream/<name>", () => {
  beforeEach(clearStore);

  const SATCAT_CSV = ["OBJECT_NAME,NORAD_CAT_ID,LAUNCH_DATE,ORBIT_TYPE", "WEATHER-1,10007,2019-11-11,ORB"].join("\r\n");

  it("stores a new file and its ETag, which /api/status then serves", async () => {
    const res = await putTable("satcat", SATCAT_CSV, { "X-Upstream-ETag": '"abc"' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "satcat", etag: '"abc"', rows: 1 });

    const { sources } = await status();
    expect(sources.satcat).toMatchObject({ etag: '"abc"', rows: 1, stale: false });
    expect(sources.satcat!.updated).toBe(sources.satcat!.checked);
    // Stored compressed: gzip's magic bytes.
    const stored = (await store().readUpstream("satcat"))!;
    expect(Array.from(stored.slice(0, 2))).toEqual([0x1f, 0x8b]);
  });

  it("refuses a file that does not parse with 422, and keeps the stored one", async () => {
    await putTable("satcat", SATCAT_CSV, { "X-Upstream-ETag": '"abc"' });
    const res = await putTable("satcat", "<html>503 Service Unavailable</html>", { "X-Upstream-ETag": '"def"' });

    expect(res.status).toBe(422);
    const { sources } = await status();
    expect(sources.satcat).toMatchObject({ etag: '"abc"', rows: 1 });
    expect(sources.satcat!.lastError).toMatch(/^refused: /);
  });

  it("records a 304 report as a check, and an error report as the last error", async () => {
    await putTable("satcat", SATCAT_CSV, { "X-Upstream-ETag": '"abc"' });
    const updated = (await status()).sources.satcat!.updated;

    expect((await reportTable("satcat", { "X-Upstream-Status": "304" })).status).toBe(200);
    expect((await status()).sources.satcat).toMatchObject({ updated, etag: '"abc"' });

    expect((await reportTable("satcat", { "X-Upstream-Error": "HTTP 522" })).status).toBe(200);
    expect((await status()).sources.satcat).toMatchObject({ updated, lastError: "HTTP 522" });
  });

  it("400s a new file without a body, 404s an unknown table, 405s another method", async () => {
    expect((await putTable("satcat", "")).status).toBe(400);
    expect((await putTable("nonsense", SATCAT_CSV)).status).toBe(404);
    expect((await SELF.fetch("https://satvis.space/api/upstream/satcat")).status).toBe(405);
  });

  it("needs the token", async () => {
    const res = await SELF.fetch("https://satvis.space/api/upstream/satcat", { method: "PUT", body: SATCAT_CSV });
    expect(res.status).toBe(401);
    expect((await status()).sources.satcat).not.toHaveProperty("rows");
  });
});

describe("GET /api/status", () => {
  beforeEach(clearStore);

  it("marks everything stale before anything is stored or written", async () => {
    const body = await status();
    expect(body.stale).toBe(true);
    expect(Object.keys(body.sources)).toEqual(UPSTREAMS.map((spec) => spec.name));
    expect(body.sources.gcat).toEqual({ stored: false, stale: true });
    expect(body.groups.every((group) => group.stale)).toBe(true);
  });

  it("marks a group stale twelve hours after its last write, and a table after its threshold", async () => {
    const fresh = new Date().toISOString();
    const old = new Date(Date.now() - 13 * 3600_000).toISOString();
    await store().writeIndex({
      updated: fresh,
      groups: [
        { name: "weather", updated: old, count: 1 },
        { name: "stations", updated: fresh, count: 1 },
      ],
    });
    // SATCAT goes stale after two days without a check, the GCAT tables after ten.
    await store().writeStatus("satcat", { checked: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() });
    await store().writeStatus("gcat", { checked: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() });
    await store().writeUpstream("satcat", new TextEncoder().encode("stored"));
    await store().writeUpstream("gcat", new TextEncoder().encode("stored"));

    const body = await status();
    expect(body.built).toBe(fresh);
    expect(body.groups.find((group) => group.name === "weather")?.stale).toBe(true);
    expect(body.groups.find((group) => group.name === "stations")?.stale).toBe(false);
    expect(body.sources.satcat?.stale).toBe(true);
    expect(body.sources.gcat?.stale).toBe(false);
  });

  it("marks a table without its file stale, and gives no ETag for it", async () => {
    await store().writeStatus("gcat", { checked: new Date().toISOString(), etag: '"cat1"' });
    expect((await status()).sources.gcat).toEqual({ checked: expect.any(String), stored: false, stale: true });
  });
});

describe("POST /api/upstream/refresh and the catalog schedule", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(async () => {
    await clearStore();
    // Every table answers 304, except GCAT's catalog, which is new.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === GCAT_CATALOG_URL) {
        return new Response(gcatCatalog(GCAT_CATALOG_LINES.ISS), { headers: { ETag: '"cat1"' } });
      }
      if (UPSTREAMS.some((spec) => spec.url === request.url)) {
        return new Response(null, { status: 304 });
      }
      throw new Error(`unmocked fetch: ${request.url}`);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads every table, and stores the changed one", async () => {
    const res = await SELF.fetch("https://satvis.space/api/upstream/refresh", { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(UPSTREAMS.length);
    expect(((await res.json()) as { sources: Record<string, { etag?: string }> }).sources.gcat).toMatchObject({ etag: '"cat1"' });
    expect((await status()).sources.gcat).toMatchObject({ rows: 1, etag: '"cat1"' });
  });

  it("runs on the catalog cron, and fetches no GP source", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: CATALOG_CRON }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(fetchSpy).toHaveBeenCalledTimes(UPSTREAMS.length);
    expect((await status()).sources.gcat).toMatchObject({ rows: 1 });
  });

  it("needs the token", async () => {
    const res = await SELF.fetch("https://satvis.space/api/upstream/refresh", { method: "POST" });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
