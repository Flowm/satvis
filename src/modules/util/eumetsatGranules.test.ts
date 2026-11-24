import { afterEach, describe, expect, test, vi } from "vitest";

import { dataStoreSearchUrl, fetchDataStoreGranules, joinAtAntimeridian, parseDataStoreGranule } from "./eumetsatGranules";
import { SPLIT } from "./eumetsatGranules.fixtures";

/** A feature of the Data Store's answer, starting at `start`, over `geometry`. */
function feature(start: string, geometry: unknown = SPLIT) {
  const end = new Date(Date.parse(start) + 3 * 60 * 1000).toISOString();
  return { type: "Feature", geometry, properties: { date: `${start}/${end}` } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dataStoreSearchUrl", () => {
  test("asks for the collection's granules of one satellite, oldest first, or the newest few", () => {
    const query = { collections: ["EO:EUM:DAT:0409"], platform: "Sentinel-3A", start: Date.parse("2026-11-20T00:00:00Z"), end: Date.parse("2026-11-20T04:00:00Z") };
    const params = Object.fromEntries(new URL(dataStoreSearchUrl(query, 1)).searchParams);
    expect(params).toMatchObject({
      pi: "EO:EUM:DAT:0409",
      sat: "Sentinel-3A",
      dtstart: "2026-11-20T00:00:00.000Z",
      dtend: "2026-11-20T04:00:00.000Z",
      c: "500",
      si: "500",
      sort: "start,time,1",
    });
    const newest = Object.fromEntries(new URL(dataStoreSearchUrl({ ...query, newest: 36, point: { latitude: 48.1, longitude: 11.6 } })).searchParams);
    expect(newest).toMatchObject({ c: "36", sort: "start,time,0", geo: "POINT(11.6 48.1)" });
  });
});

describe("joinAtAntimeridian", () => {
  test("joins the two parts of a granule split at 180° into one ring, the western part a turn east", () => {
    const ring = joinAtAntimeridian(SPLIT.coordinates.map((polygon) => polygon[0] as [number, number][]))!;
    expect(ring[0]).toEqual(ring.at(-1));
    const longitudes = ring.map(([longitude]) => longitude);
    expect(Math.min(...longitudes)).toBeCloseTo(175.36);
    expect(Math.max(...longitudes)).toBeCloseTo(360 - 167.67);
    // The cut along 180° is gone, its two ends left (the last point closes the ring).
    expect(longitudes.slice(0, -1).filter((longitude) => longitude === 180)).toHaveLength(2);
  });

  test("leaves parts that do not meet at 180° unjoined", () => {
    const square = (west: number): [number, number][] => [
      [west, 0],
      [west + 1, 0],
      [west + 1, 1],
      [west, 1],
      [west, 0],
    ];
    expect(joinAtAntimeridian([square(10), square(20)])).toBeUndefined();
  });
});

describe("parseDataStoreGranule", () => {
  test("reads the times, the joined outline, and whether by day from the sun", () => {
    const granule = parseDataStoreGranule(feature("2026-11-20T21:55:48Z"))!;
    expect(granule.start).toBe(Date.parse("2026-11-20T21:55:48Z"));
    expect(granule.end - granule.start).toBe(3 * 60 * 1000);
    expect(granule.outline[0]).toEqual(granule.outline.at(-1));
    // Local morning over the Pacific, at 31° to 42° N in November.
    expect(granule.day).toBe(true);
  });

  test("leaves out a feature without times or a polygon", () => {
    expect(parseDataStoreGranule({ properties: { date: "yesterday" }, geometry: SPLIT })).toBeUndefined();
    expect(parseDataStoreGranule(feature("2026-11-20T21:55:48Z", { type: "Point", coordinates: [0, 0] }))).toBeUndefined();
  });
});

describe("fetchDataStoreGranules", () => {
  const query = { collections: ["EO:EUM:DAT:0409"], platform: "Sentinel-3A", start: 0, end: 1 };

  test("keeps one of a near-real-time and an archived copy of a granule, sorted by start", async () => {
    const answer = { totalResults: 3, features: [feature("2026-11-20T21:58:48.646455Z"), feature("2026-11-20T21:55:48.646455Z"), feature("2026-11-20T21:55:48.646463Z")] };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(answer)));
    const granules = await fetchDataStoreGranules(query, new AbortController().signal);
    expect(granules?.map((granule) => new Date(granule.start).toISOString())).toEqual(["2026-11-20T21:55:48.646Z", "2026-11-20T21:58:48.646Z"]);
  });

  test("asks for the next page while one comes back full", async () => {
    const pages = [
      { totalResults: 501, features: Array.from({ length: 500 }, (_, i) => feature(new Date(Date.parse("2026-11-20T00:00:00Z") + i * 180_000).toISOString())) },
      { totalResults: 501, features: [feature("2026-11-22T00:00:00Z")] },
    ];
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(pages.shift())));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchDataStoreGranules(query, new AbortController().signal)).toHaveLength(501);
    expect(new URL(fetchMock.mock.calls[1]![0]).searchParams.get("si")).toBe("500");
  });

  test("is undefined where the Data Store answers with an error", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    expect(await fetchDataStoreGranules(query, new AbortController().signal)).toBeUndefined();
  });
});
