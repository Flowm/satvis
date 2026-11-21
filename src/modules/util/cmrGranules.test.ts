import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchGranules, granuleExtent, granuleSearchUrl, groupOverpasses, parseGranule } from "./cmrGranules";

const MINUTE = 60 * 1000;

/** An entry of CMR's JSON feed, as it answered on 2026-11-20. */
function entry(start: string, collection = "VJ103MOD_NRT", dayNight = "DAY") {
  const startMs = Date.parse(start);
  return {
    producer_granule_id: `${collection}.A2026324.0954.021.2026324113215.nc`,
    time_start: new Date(startMs).toISOString(),
    time_end: new Date(startMs + 6 * MINUTE).toISOString(),
    day_night_flag: dayNight,
    polygons: [["14.218523 38.306084 18.426548 66.22702 39.330738 63.761784 34.278229 30.160732 14.218523 38.306084"]],
  };
}

describe("parseGranule", () => {
  test("reads the times, whether it was day, and the outer ring as latitude and longitude", () => {
    const granule = parseGranule(entry("2026-11-20T09:54:00Z"))!;
    expect(granule.start).toBe(Date.parse("2026-11-20T09:54:00Z"));
    expect(granule.end - granule.start).toBe(6 * MINUTE);
    expect(granule.day).toBe(true);
    expect(granule.outline).toHaveLength(5);
    expect(granule.outline[0]).toEqual({ latitude: 14.218523, longitude: 38.306084 });
  });

  test("counts a granule CMR calls BOTH as day, and NIGHT not", () => {
    expect(parseGranule(entry("2026-11-20T09:54:00Z", "VJ103MOD", "BOTH"))?.day).toBe(true);
    expect(parseGranule(entry("2026-11-20T09:54:00Z", "VJ103MOD", "NIGHT"))?.day).toBe(false);
  });

  test.each([
    [{ ...entry("2026-11-20T09:54:00Z"), polygons: undefined }],
    [{ ...entry("2026-11-20T09:54:00Z"), polygons: [["1 2 3"]] }],
    [{ ...entry("2026-11-20T09:54:00Z"), time_start: "yesterday" }],
    [null],
  ])("leaves out an entry without times or a polygon: %#", (raw) => {
    expect(parseGranule(raw)).toBeUndefined();
  });
});

describe("granuleExtent", () => {
  const ring = (...points: [number, number][]) => ({ start: 0, end: 0, day: true, outline: points.map(([latitude, longitude]) => ({ latitude, longitude })) });

  test("bounds a granule's corners", () => {
    expect(granuleExtent(ring([33, -8], [36, 30], [60, 32], [57, -5], [33, -8]))).toEqual({ west: -8, south: 33, east: 32, north: 60 });
  });

  test("unwraps a granule across the antimeridian from its first corner", () => {
    expect(granuleExtent(ring([10, 170], [12, -170], [30, -165], [28, 172], [10, 170]))).toEqual({ west: 170, south: 10, east: 195, north: 30 });
  });
});

describe("granuleSearchUrl", () => {
  test("asks for each collection, the times, a point as longitude and latitude, by start", () => {
    const url = new URL(
      granuleSearchUrl({
        collections: ["VJ103MOD_NRT", "VJ103MOD"],
        start: Date.parse("2026-11-20T00:00:00Z"),
        end: Date.parse("2026-11-21T00:00:00Z"),
        point: { latitude: 48.1, longitude: 11.5 },
      }),
    );
    expect(url.searchParams.getAll("short_name")).toEqual(["VJ103MOD_NRT", "VJ103MOD"]);
    expect(url.searchParams.get("temporal")).toBe("2026-11-20T00:00:00.000Z,2026-11-21T00:00:00.000Z");
    expect(url.searchParams.get("point")).toBe("11.5,48.1");
    expect(url.searchParams.get("sort_key")).toBe("start_date");
  });
});

describe("fetchGranules", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const query = { collections: ["VJ103MOD_NRT", "VJ103MOD"], start: 0, end: 1 };

  test("keeps one granule a start, the first collection's, sorted by start, and names the client", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        feed: { entry: [entry("2026-11-20T10:00:00Z", "VJ103MOD"), entry("2026-11-20T09:54:00Z", "VJ103MOD"), entry("2026-11-20T09:54:00Z", "VJ103MOD_NRT", "BOTH")] },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const granules = await fetchGranules(query, new AbortController().signal);
    expect(granules?.map((granule) => new Date(granule.start).toISOString())).toEqual(["2026-11-20T09:54:00.000Z", "2026-11-20T10:00:00.000Z"]);
    // The near-real-time copy, which is the one CMR calls BOTH here.
    expect(granules?.[0]?.day).toBe(true);
    expect(fetch.mock.calls[0]).toMatchObject([expect.any(String), { headers: { "Client-Id": "satvis" } }]);
  });

  test("is undefined where CMR answers with an error or not at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("throttled", { status: 429 })),
    );
    expect(await fetchGranules(query, new AbortController().signal)).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("offline"))),
    );
    expect(await fetchGranules(query, new AbortController().signal)).toBeUndefined();
  });
});

describe("groupOverpasses", () => {
  test("joins granules that follow one another, and parts those with a gap", () => {
    const granules = ["09:54", "10:00", "10:06", "11:36"].map((time) => parseGranule(entry(`2026-11-20T${time}:00Z`))!);
    const overpasses = groupOverpasses(granules);
    expect(overpasses.map(({ granules: members }) => members.length)).toEqual([3, 1]);
    expect(overpasses[0]!.end - overpasses[0]!.start).toBe(18 * MINUTE);
  });
});
