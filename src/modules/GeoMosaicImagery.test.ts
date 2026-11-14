import { Tiff, TiffTag } from "@cogeotiff/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CogImageryProvider, rangeSource } from "./CogImageryProvider";
import { geoMosaicFrames, itemFile } from "./GeoMosaicImagery";

const BUCKET = "https://s.satvis.space/geo";
const COLLECTION = `${BUCKET}/mosaic/collection.json`;
const ITEM_03 = `${BUCKET}/mosaic/2026/11/13/georing_mosaic_20261113T0300Z.json`;

const item = (name: string, attribution = ["GOES-19 imagery: NOAA.", "Contains modified EUMETSAT Meteosat data 2026"]) => ({
  type: "Feature",
  properties: { datetime: "2026-11-13T03:00:00Z", "georing:attribution": attribution },
  assets: { image: { href: `./${name}.tif`, type: "image/tiff; application=geotiff; profile=cloud-optimized" } },
});

/** The bucket as it is laid out now: the collection links each item, relative to itself, with the item's time. */
const FLAT: Record<string, object> = {
  [COLLECTION]: {
    links: [
      { rel: "root", href: "../catalog.json" },
      { rel: "item", href: "./2026/11/13/georing_mosaic_20261113T0300Z.json", datetime: "2026-11-13T03:00:00Z" },
      { rel: "item", href: "./2026/11/12/georing_mosaic_20261112T2300Z.json", datetime: "2026-11-12T23:00:00Z" },
      // The time is the link's, whatever the item is called.
      { rel: "item", href: "./2026/11/13/early.json", datetime: "2026-11-13T01:00:00Z" },
      { rel: "item", href: "./2026/11/13/georing_mosaic_20261113T0400Z.json" },
    ],
  },
  [ITEM_03]: item("georing_mosaic_20261113T0300Z"),
};

let bucket: Record<string, object>;
const served = async (url: string) => (url in bucket ? Response.json(bucket[url]) : new Response("", { status: 404 }));
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  bucket = FLAT;
  fetchMock = vi.fn(served);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const signal = () => new AbortController().signal;
/** Any time: the collection is listed whole. */
const AROUND = Date.parse("2026-11-13T02:00:00Z");
const iso = (time: number) => new Date(time).toISOString();

describe("the Mosaic's frames", () => {
  test("are the times on the collection's item links, oldest first, each a frame of its own; a link without one is skipped", async () => {
    const ranges = (await geoMosaicFrames().fetchRanges(signal(), AROUND))?.ranges;
    expect(ranges?.map((range) => iso(range.start))).toEqual(["2026-11-12T23:00:00.000Z", "2026-11-13T01:00:00.000Z", "2026-11-13T03:00:00.000Z"]);
    expect(ranges?.every((range) => range.end === range.start && range.step === 0)).toBe(true);
  });

  test.each([
    ["cannot be read", {}],
    ["lists no item", { [COLLECTION]: { links: [{ rel: "root", href: "../catalog.json" }] } }],
  ])("are unknown when the collection %s", async (_, layout) => {
    bucket = layout;
    expect(await geoMosaicFrames().fetchRanges(signal(), AROUND)).toBeUndefined();
  });

  test("show the COG of the item listed for the frame", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const frames = geoMosaicFrames();
    await frames.fetchRanges(signal(), AROUND);
    frames.show(Date.parse("2026-11-13T03:00:00Z"));
    await vi.waitFor(() => expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([COLLECTION, ITEM_03, `${BUCKET}/mosaic/2026/11/13/georing_mosaic_20261113T0300Z.tif`]));
  });
});

describe("an item", () => {
  test("gives its cloud-optimized asset, beside it, and its attribution as credits", async () => {
    expect(await itemFile(ITEM_03)).toEqual({
      url: `${BUCKET}/mosaic/2026/11/13/georing_mosaic_20261113T0300Z.tif`,
      credits: ["GOES-19 imagery: NOAA.", "Contains modified EUMETSAT Meteosat data 2026"],
    });
  });

  test("without a COG among its assets is refused", async () => {
    bucket = { [ITEM_03]: { assets: { thumbnail: { href: "./a.png", type: "image/png" } } } };
    await expect(itemFile(ITEM_03)).rejects.toThrow("no cloud-optimized GeoTIFF");
  });
});

describe("rangeSource", () => {
  test("asks for the bytes it reads", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(4), { status: 206 }));
    await rangeSource(`${BUCKET}/a.tif`).fetch(16, 4);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toEqual({ Range: "bytes=16-19" });
  });

  // A server that ignores the range sends the whole file, hundreds of MB.
  test("refuses a whole-file answer", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(4), { status: 200 }));
    await expect(rangeSource(`${BUCKET}/a.tif`).fetch(0, 4)).rejects.toThrow("HTTP 200");
  });
});

describe("CogImageryProvider", () => {
  // One lost request for a level's tile index leaves only that level waiting, not the frame blank.
  test("asks again for a tile index it could not read", async () => {
    const half = 20037508.342789244;
    let fails = 1;
    const image = {
      epsg: 3857,
      bbox: [-half, -half, half, half],
      size: { width: 512, height: 512 },
      tileSize: { width: 512, height: 512 },
      tileCount: { x: 1, y: 1 },
      fetch: vi.fn(async (tag: TiffTag) => {
        if (tag === TiffTag.TileOffsets && fails-- > 0) {
          throw new Error("lost");
        }
        return [0];
      }),
    };
    vi.spyOn(Tiff, "create").mockResolvedValue({ images: [image], source: { url: new URL(`${BUCKET}/a.tif`) } } as unknown as Tiff);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Cesium's empty tile, for the sparse one, is an Image.
    vi.stubGlobal("Image", class {});
    const provider = new CogImageryProvider({ file: Promise.resolve({ url: `${BUCKET}/a.tif`, credits: ["NOAA"] }), tileSize: 512, maximumLevel: 0 });
    // Undefined, "ask again", until the header and then the index are read.
    await vi.waitFor(() => {
      provider.requestImage(0, 0, 0);
      expect(console.warn).toHaveBeenCalled();
    });
    // Waits for the tile to resolve, which an unreadable frame's never does.
    expect(await vi.waitFor(() => provider.requestImage(0, 0, 0) ?? Promise.reject(new Error("still loading")))).toBeDefined();
    expect(provider.getTileCredits().map((credit) => credit.html)).toEqual(["NOAA"]);
  });
});
