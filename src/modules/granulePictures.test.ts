import { afterEach, describe, expect, test, vi } from "vitest";

import { cutHasGranule, picturesEnd, probeBounds } from "./granulePictures";
import type { Granule } from "./util/cmrGranules";

/** A granule `width`° by `height`° from 140° E, 30° S, starting at `start`. */
function granule(start: string, width = 12, height = 10): Granule {
  const outline = [
    { latitude: -30, longitude: 140 },
    { latitude: -30, longitude: 140 + width },
    { latitude: -30 + height, longitude: 140 + width },
    { latitude: -30 + height, longitude: 140 },
    { latitude: -30, longitude: 140 },
  ];
  return { start: Date.parse(start), end: Date.parse(start) + 180_000, day: true, outline };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeBounds", () => {
  test("is 2° around the granule's centre, or a quarter of a small granule", () => {
    expect(probeBounds(granule("2026-11-20T23:55:00Z"))).toEqual({ west: 145, south: -26, east: 147, north: -24 });
    const scene = probeBounds(granule("2026-11-20T23:55:00Z", 1.2, 1));
    expect(scene.east - scene.west).toBeCloseTo(0.5);
  });

  test("keeps to one side of the antimeridian", () => {
    const across = granule("2026-11-09T20:05:00Z", 80);
    expect(probeBounds(across)).toEqual({ west: -180, south: -26, east: -178, north: -24 });
  });
});

describe("cutHasGranule", () => {
  const pictures = { provider: "eumetview" as const, layer: "copernicus:sentinel3a", frame: 25 * 60 * 1000 };

  test("asks for the granule's frame around its centre, on black", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(new Uint8Array([0xff]), { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await cutHasGranule(pictures, granule("2026-11-20T23:55:00Z"))).toBe(true);
    const params = Object.fromEntries(new URL(fetchMock.mock.calls[0]![0]).searchParams);
    expect(params).toMatchObject({ LAYERS: "copernicus:sentinel3a", TIME: "2026-11-21T00:20:00Z", BBOX: "145.000,-26.000,147.000,-24.000", BGCOLOR: "0x000000" });
  });

  test("has none where the provider answers each try with an exception, though its status is 200", async () => {
    const fetchMock = vi.fn(async () => new Response("<ServiceExceptionReport/>", { headers: { "content-type": "application/vnd.ogc.se_xml" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await cutHasGranule(pictures, granule("2026-11-20T21:00:00Z"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("asks again after an exception, as GIBS answers one request in five at random", async () => {
    const answers = [
      new Response("<ServiceExceptionReport/>", { headers: { "content-type": "application/vnd.ogc.se_xml" } }),
      new Response(new Uint8Array([0xff]), { headers: { "content-type": "image/jpeg" } }),
    ];
    vi.stubGlobal("fetch", async () => answers.shift());
    expect(await cutHasGranule(pictures, granule("2026-11-20T22:00:00Z"))).toBe(true);
  });

  test("asks for each of the tiles that share a start, as HLS's of one scene do", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const tile = granule("2026-11-20T10:00:00Z", 1.2, 1);
    const beside = { ...tile, outline: tile.outline.map(({ latitude, longitude }) => ({ latitude, longitude: longitude + 1 })) };
    await cutHasGranule(pictures, tile);
    await cutHasGranule(pictures, beside);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("picturesEnd", () => {
  const signal = new AbortController().signal;

  test("is the end of a daily layer's newest day", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response("<Domains><Domain>2024-03-21/2026-11-09/P1D</Domain></Domains>"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await picturesEnd({ provider: "gibs", layer: "OCI_PACE_True_Color", frame: "day" }, signal)).toBe(Date.parse("2026-11-10T00:00:00Z"));
    expect(fetchMock.mock.calls[0]![0]).toContain("/OCI_PACE_True_Color/default/GoogleMapsCompatible_Level9/all/all.xml");
  });

  test("is an hour past EUMETView's newest listed frame", async () => {
    const capabilities = '<Dimension name="time" default="current">2020-02-17T03:01:00.000Z/2026-11-22T00:46:00.000Z/PT1H41M</Dimension>';
    vi.stubGlobal("fetch", async () => new Response(capabilities));
    expect(await picturesEnd({ provider: "eumetview", layer: "copernicus:sentinel3a", frame: 25 * 60 * 1000 }, signal)).toBe(Date.parse("2026-11-22T01:46:00Z"));
  });

  test("is undefined for a layer's own granule frames, and where the provider does not answer", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    expect(await picturesEnd({ provider: "gibs", layer: "VIIRS_NOAA20_CorrectedReflectance_Granule", frame: "granule" }, signal)).toBeUndefined();
    expect(await picturesEnd({ provider: "gibs", layer: "OCI_PACE_True_Color", frame: "day" }, signal)).toBeUndefined();
  });
});
