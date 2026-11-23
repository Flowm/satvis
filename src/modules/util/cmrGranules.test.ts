import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchGranules, granuleExtent, granuleKey, granuleSearchUrl, groupOverpasses, parseGranule, withoutPoleCut } from "./cmrGranules";

const MINUTE = 60 * 1000;

/** An entry of CMR's JSON feed, as it answered on 2026-11-20. */
function entry(start: string, collection = "C2208781576-LANCEMODIS", dayNight = "DAY") {
  const startMs = Date.parse(start);
  return {
    collection_concept_id: collection,
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
    expect(parseGranule(entry("2026-11-20T09:54:00Z", "C2105084593-LAADS", "BOTH"))?.day).toBe(true);
    expect(parseGranule(entry("2026-11-20T09:54:00Z", "C2105084593-LAADS", "NIGHT"))?.day).toBe(false);
    // NOAA's Metop granules say neither: the sun does. This one is over the Arabian Sea.
    expect(parseGranule(entry("2026-11-20T09:54:00Z", "C2205121394-POCLOUD", "UNSPECIFIED"))?.day).toBe(true);
    expect(parseGranule(entry("2026-11-20T21:54:00Z", "C2205121394-POCLOUD", "UNSPECIFIED"))?.day).toBe(false);
  });

  test("joins the parts CMR splits a granule into at the antimeridian", () => {
    // Metop-B's AVHRR, 2026-11-19T19:00Z: its first part alone was a sliver east of 180°.
    const granule = parseGranule({
      ...entry("2026-11-19T19:00:00Z", "C2205121394-POCLOUD", "UNSPECIFIED"),
      polygons: [
        ["-52.09473 170.92676 -55.43262 180 -42.13379 180 -52.09473 170.92676"],
        [
          "-19.97949 -169.02441 -32.27832 -174.1543 -42.13379 -180 -55.43262 -180 -59.09082 -162.30371 -59.95508 -142.99414 -45.34473 -143.42871 -25.74902 -141.63477 -23.50293 -155.42871 -19.97949 -169.02441",
        ],
      ],
    })!;
    expect(granule.outline).toHaveLength(11);
    expect(granule.outline.at(-1)).toEqual(granule.outline[0]);
    expect(granuleExtent(granule)).toEqual({ west: 170.92676, south: -59.95508, east: 218.36523, north: -19.97949 });
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

describe("withoutPoleCut", () => {
  const points = (...pairs: [number, number][]) => pairs.map(([latitude, longitude]) => ({ latitude, longitude }));

  test("leaves out the pole and the antimeridian that leads to it", () => {
    // Metop-B's AVHRR, 2026-11-19T19:10Z, cut short.
    const ring = points([-90, -180], [-90, 0], [-90, 180], [-55.4, 180], [-67.6, 101.4], [-85.4, 4.7], [-69.5, -140.4], [-55.4, -180], [-90, -180]);
    expect(withoutPoleCut(ring)).toEqual(points([-55.4, 180], [-67.6, 101.4], [-85.4, 4.7], [-69.5, -140.4], [-55.4, 180]));
  });

  test("keeps a ring that does not reach a pole", () => {
    const ring = points([10, 10], [10, 20], [20, 20], [10, 10]);
    expect(withoutPoleCut(ring)).toBe(ring);
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
        collections: ["C2208781576-LANCEMODIS", "C2105084593-LAADS"],
        start: Date.parse("2026-11-20T00:00:00Z"),
        end: Date.parse("2026-11-21T00:00:00Z"),
        point: { latitude: 48.1, longitude: 11.5 },
      }),
    );
    expect(url.searchParams.getAll("collection_concept_id")).toEqual(["C2208781576-LANCEMODIS", "C2105084593-LAADS"]);
    expect(url.searchParams.get("temporal")).toBe("2026-11-20T00:00:00.000Z,2026-11-21T00:00:00.000Z");
    expect(url.searchParams.get("point")).toBe("11.5,48.1");
    expect(url.searchParams.get("sort_key")).toBe("start_date");
  });

  test("asks for the newest few, newest first", () => {
    const url = new URL(granuleSearchUrl({ collections: ["C1-P"], start: 0, end: 1, newest: 36 }));
    expect(url.searchParams.get("page_size")).toBe("36");
    expect(url.searchParams.get("sort_key")).toBe("-start_date");
  });

  test("names the satellite in a collection that lists several", () => {
    const url = new URL(granuleSearchUrl({ collections: ["C2021957657-LPCLOUD"], platform: "LANDSAT-9", start: 0, end: 1 }));
    expect(url.searchParams.get("platform")).toBe("LANDSAT-9");
  });
});

describe("fetchGranules", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const query = { collections: ["C2208781576-LANCEMODIS", "C2105084593-LAADS"], start: 0, end: 1 };

  test("keeps one granule a start, the first collection's, sorted by start, and names the client", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        feed: {
          entry: [
            entry("2026-11-20T10:00:00Z", "C2105084593-LAADS"),
            entry("2026-11-20T09:54:00Z", "C2105084593-LAADS"),
            entry("2026-11-20T09:54:00Z", "C2208781576-LANCEMODIS", "BOTH"),
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const granules = await fetchGranules(query, new AbortController().signal);
    expect(granules?.map((granule) => new Date(granule.start).toISOString())).toEqual(["2026-11-20T09:54:00.000Z", "2026-11-20T10:00:00.000Z"]);
    // The near-real-time copy, which is the one CMR calls BOTH here.
    expect(granules?.[0]?.day).toBe(true);
    expect(fetch.mock.calls[0]).toMatchObject([expect.any(String), { headers: { "Client-Id": "satvis" } }]);
  });

  test("keeps every tile of one collection that share a start, as HLS's of one scene", async () => {
    const tile = (ring: string) => ({ ...entry("2026-11-19T09:56:30Z", "C2021957657-LPCLOUD"), polygons: [[ring]] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          feed: {
            entry: [
              tile("53.2 13.3 53.2 14.9 54.1 14.9 54.1 13.3 53.2 13.3"),
              tile("52.3 13.3 52.3 14.9 53.3 14.9 53.3 13.3 52.3 13.3"),
              entry("2026-11-19T09:56:54Z", "C2021957657-LPCLOUD"),
            ],
          },
        }),
      ),
    );
    const granules = await fetchGranules({ collections: ["C2021957657-LPCLOUD"], platform: "LANDSAT-9", start: 0, end: 1 }, new AbortController().signal);
    expect(granules?.map((granule) => granule.outline[0]?.latitude)).toEqual([53.2, 52.3, 14.218523]);
    expect(new Set(granules?.map(granuleKey)).size).toBe(3);
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
  test("joins granules that follow one another, within a second or so, and parts those with a gap", () => {
    const granules = ["09:54:00", "10:00:01", "10:06:01", "11:36:00"].map((time) => parseGranule(entry(`2026-11-20T${time}Z`))!);
    const overpasses = groupOverpasses(granules);
    expect(overpasses.map(({ granules: members }) => members.length)).toEqual([3, 1]);
    expect(overpasses[0]!.end - overpasses[0]!.start).toBe(18 * MINUTE + 1000);
  });
});
