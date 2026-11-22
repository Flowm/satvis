import { Math as CesiumMath } from "@cesium/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import { eumetViewFrames, eumetViewHasGranule, parseCapabilities } from "./EumetViewImagery";

const box = (west: number, south: number, east: number, north: number) => `<EX_GeographicBoundingBox>
  <westBoundLongitude>${west}</westBoundLongitude>
  <eastBoundLongitude>${east}</eastBoundLongitude>
  <southBoundLatitude>${south}</southBoundLatitude>
  <northBoundLatitude>${north}</northBoundLatitude>
</EX_GeographicBoundingBox>`;

/** A layer's capabilities as EUMETView nests them: the layer inside its workspace's. */
const capabilities = (layerBox: string, dimension: string) => `<Layer><Title>EUMETSAT</Title>${box(-180, -90, 180, 90)}
  <Layer queryable="1"><Name>rgb_geocolour</Name>${layerBox}
    <Dimension name="time" default="2026-11-12T01:20:00Z" units="ISO8601" nearestValue="1">${dimension}</Dimension>
  </Layer></Layer>`;

const GEOCOLOUR = capabilities(box(-81.28, -77.35, 81.28, 77.36), "2024-09-23T00:00:00.000Z/2026-11-12T01:20:00.000Z/PT10M");
const OPTIONS = { layer: "mtg_fd:rgb_geocolour", maximumLevel: 7, format: "png" as const };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseCapabilities", () => {
  test("reads the layer's frames and its own box, not its workspace's", () => {
    expect(parseCapabilities(GEOCOLOUR)).toEqual({
      ranges: [{ start: Date.parse("2024-09-23T00:00:00Z"), end: Date.parse("2026-11-12T01:20:00Z"), step: 10 * 60 * 1000 }],
      bounds: [-81.28, -77.35, 81.28, 77.36],
    });
  });

  test("reads a polar layer's step of an orbit, and keeps its box on the globe", () => {
    const { ranges, bounds } = parseCapabilities(capabilities(box(-180, -84.3, 180.005, 69.79), "2020-02-17T03:01:00.000Z/2026-11-11T20:48:00.000Z/PT1H41M"));
    expect(ranges[0]!.step).toBe(101 * 60 * 1000);
    expect(bounds).toEqual([-180, -84.3, 180, 69.79]);
  });

  test("says so where the capabilities name no frames or no box", () => {
    expect(parseCapabilities("<ServiceExceptionReport/>")).toEqual({ ranges: [], bounds: undefined });
  });
});

describe("eumetViewFrames", () => {
  test("asks the layer's own capabilities, and draws inside the box they give", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(GEOCOLOUR));
    vi.stubGlobal("fetch", fetchMock);
    const frames = eumetViewFrames(OPTIONS);

    const ranges = (await frames.fetchRanges(new AbortController().signal, 0))?.ranges;
    expect(fetchMock.mock.calls[0]![0]).toBe("https://view.eumetsat.int/geoserver/mtg_fd/rgb_geocolour/ows?service=WMS&version=1.3.0&request=GetCapabilities");
    expect(ranges).toHaveLength(1);

    const provider = frames.show(ranges![0]!.end);
    expect(provider.rectangle.west).toBeCloseTo(CesiumMath.toRadians(-81.28));
    expect(provider.rectangle.north).toBeCloseTo(CesiumMath.toRadians(77.36));
    // 512-pixel geographic tiles: two levels above the manifest's Web Mercator one.
    expect(provider.maximumLevel).toBe(5);
    expect(provider.tileWidth).toBe(512);
  });

  test.each([
    ["cannot be reached", () => Promise.reject(new TypeError("offline"))],
    ["refuses", () => Promise.resolve(new Response("", { status: 503 }))],
    ["names no frames", () => Promise.resolve(new Response("<ServiceExceptionReport/>"))],
  ])("has no frames when the service %s, and still draws its latest", async (_, answer) => {
    vi.stubGlobal("fetch", vi.fn(answer));
    const frames = eumetViewFrames(OPTIONS);
    expect(await frames.fetchRanges(new AbortController().signal, 0)).toBeUndefined();
    expect(frames.show().rectangle.west).toBeCloseTo(-Math.PI);
  });
});

describe("eumetViewHasGranule", () => {
  const granule = (start: string) => ({
    start: Date.parse(start),
    end: Date.parse(start) + 3 * 60 * 1000,
    day: true,
    outline: [
      { latitude: -20, longitude: 140 },
      { latitude: -22, longitude: 152 },
      { latitude: -32, longitude: 150 },
      { latitude: -30, longitude: 138 },
      { latitude: -20, longitude: 140 },
    ],
  });

  test("asks for the swath of the granule's pass around its centre", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(new Uint8Array([0x89]), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await eumetViewHasGranule("copernicus:a", granule("2026-11-20T23:55:00Z"))).toBe(true);
    const params = Object.fromEntries(new URL(fetchMock.mock.calls[0]![0]).searchParams);
    expect(params).toMatchObject({ layers: "copernicus:a", time: "2026-11-21T00:20:00Z", bbox: "144.000,-27.000,146.000,-25.000", transparent: "true" });
  });

  test("has none where EUMETView answers with an exception, though its status is 200", async () => {
    vi.stubGlobal("fetch", async () => new Response("<ServiceExceptionReport/>", { headers: { "content-type": "application/vnd.ogc.se_xml" } }));
    expect(await eumetViewHasGranule("copernicus:a", granule("2026-11-20T21:00:00Z"))).toBe(false);
  });
});
