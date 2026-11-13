import { Math as CesiumMath } from "@cesium/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import { eumetViewFrames, parseCapabilities } from "./EumetViewImagery";

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
