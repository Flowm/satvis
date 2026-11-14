// The geostationary Mosaic frame by frame (FramedImagery.ts): one cloud-optimized GeoTIFF
// an hour, the four geostationary satellites joined on one Web Mercator grid, made by the
// georing-mosaic project and read straight from its bucket. Its static STAC collection
// lists the Slots, an item each.

import { Tiff } from "@cogeotiff/core";

import type { PreviewBounds } from "@/config/instrumentImagery";

import { type CogFile, CogImageryProvider, rangeSource } from "./CogImageryProvider";
import type { FrameList, FrameSource } from "./FramedImagery";

const BUCKET = "https://s.satvis.space/geo";
const COLLECTION = `${BUCKET}/mosaic/collection.json`;

/** Web Mercator zoom 8 in 256-pixel tiles, written as 512-pixel blocks. */
const TILE_SIZE = 512;
const MAXIMUM_LEVEL = 7;

/** A Slot is built from 14 to 35 minutes past its hour; asking more often finds nothing new. */
const REFRESH_MS = 10 * 60 * 1000;

/** A STAC link; an item's carries the item's `datetime`, so the collection alone gives the Slots. */
interface StacLink {
  rel?: string;
  href?: string;
  datetime?: string;
}

/** What is read of a STAC catalogue, collection or item. */
interface StacDocument {
  links?: StacLink[];
}

/** What is read of an item: its attribution and the asset that is the COG. */
interface StacItem {
  properties?: { "georing:attribution"?: string[] };
  assets?: Record<string, { href?: string; type?: string }>;
}

/** The JSON at `url`; throws on any status but a success. */
async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/** Each Slot the collection lists, in epoch milliseconds, to its item's url. A link without a time is skipped. */
async function fetchItems(signal?: AbortSignal): Promise<Map<number, string>> {
  const collection = await fetchJson<StacDocument>(COLLECTION, signal);
  const items = new Map<number, string>();
  for (const { rel, href, datetime } of collection.links ?? []) {
    const slot = Date.parse(datetime ?? "");
    if (rel === "item" && href && !Number.isNaN(slot)) {
      items.set(slot, new URL(href, COLLECTION).href);
    }
  }
  return items;
}

/** The COG an item's assets hold, and the attribution it asks for. */
export async function itemFile(itemUrl: string): Promise<CogFile> {
  const item = await fetchJson<StacItem>(itemUrl);
  const asset = Object.values(item.assets ?? {}).find((candidate) => candidate.href && candidate.type?.includes("profile=cloud-optimized"));
  if (!asset) {
    throw new Error(`${itemUrl}: no cloud-optimized GeoTIFF among its assets`);
  }
  return { url: new URL(asset.href!, itemUrl).href, credits: item.properties?.["georing:attribution"] ?? [] };
}

/** The newest complete Slot's item, which `latest.json` names: for when the collection cannot be read. */
async function latestFile(): Promise<CogFile> {
  const latest = await fetchJson<{ item: string }>(`${BUCKET}/latest.json`);
  return itemFile(new URL(latest.item, `${BUCKET}/`).href);
}

/** The newest Slot the collection lists, as the globe would show it with the clock past it. */
async function newestFile(): Promise<CogFile> {
  const items = await fetchItems().catch(() => undefined);
  const newest = items?.size ? Math.max(...items.keys()) : undefined;
  return newest === undefined ? latestFile() : itemFile(items!.get(newest)!);
}

/** The newest Slot's file as last opened, and until when it is the newest. */
let newestTiff: { until: number; tiff: Promise<Tiff> } | undefined;
/** The newest Slot's file, opened once for every preview until the collection is due again. */
function openNewest(): Promise<Tiff> {
  if (newestTiff === undefined || Date.now() > newestTiff.until) {
    const tiff = newestFile().then(({ url }) => Tiff.create(rangeSource(url)));
    newestTiff = { until: Date.now() + REFRESH_MS, tiff };
    // A failure is not kept: the next preview asks again.
    tiff.catch(() => {
      if (newestTiff?.tiff === tiff) newestTiff = undefined;
    });
  }
  return newestTiff.tiff;
}

/** The Mosaic's frames: the collection's Slots, each drawn from its item's COG. */
export function geoMosaicFrames(): FrameSource<CogImageryProvider> {
  // The Slots last listed, to their items.
  let items = new Map<number, string>();
  return {
    name: "georing mosaic",
    refreshMs: REFRESH_MS,
    // The whole week is one small file, so `around` is not needed.
    fetchRanges: async (signal): Promise<FrameList | undefined> => {
      const listed = await fetchItems(signal).catch(() => undefined);
      if (!listed?.size) {
        return undefined;
      }
      items = listed;
      return { ranges: [...items.keys()].toSorted((a, b) => a - b).map((slot) => ({ start: slot, end: slot, step: 0 })) };
    },
    show: (frame) => {
      const item = frame === undefined ? undefined : items.get(frame);
      return new CogImageryProvider({
        file: item ? itemFile(item) : latestFile(),
        tileSize: TILE_SIZE,
        maximumLevel: MAXIMUM_LEVEL,
      });
    },
  };
}

// Web Mercator pixel coordinates in an image `size` pixels square.
const mercatorX = (longitude: number, size: number) => ((longitude + 180) / 360) * size;
const mercatorY = (latitude: number, size: number) => ((1 - Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) / Math.PI) / 2) * size;

/**
 * The newest Slot in `bounds`, `width` by `height` pixels in plate carrée, as the WMS
 * previews of the other layers are: the blocks of the coarsest level with a pixel for
 * each of the picture's, a request each, resampled to the nearest pixel. Transparent
 * where the Mosaic is not. Across the antimeridian the blocks wrap. `signal` stops the
 * blocks; the file's header is every preview's.
 */
export async function geoMosaicPreview(bounds: PreviewBounds, width: number, height: number, signal?: AbortSignal): Promise<Blob> {
  const tiff = await openNewest();
  const url = tiff.source.url.href;
  const levels = tiff.images.filter((image) => image.size.width === image.size.height && image.tileSize.width === TILE_SIZE).toSorted((a, b) => a.size.width - b.size.width);
  const image = levels.find((level) => (level.size.width * (bounds.east - bounds.west)) / 360 >= width) ?? levels.at(-1);
  if (!image) {
    throw new Error(`${url}: no level of ${TILE_SIZE}-pixel blocks`);
  }
  const size = image.size.width;
  const blocks = image.tileCount.x;
  const firstX = Math.floor(mercatorX(bounds.west, size) / TILE_SIZE);
  const lastX = Math.floor(mercatorX(bounds.east, size) / TILE_SIZE);
  const row = (latitude: number) => Math.max(0, Math.min(blocks - 1, Math.floor(mercatorY(latitude, size) / TILE_SIZE)));
  const firstY = row(bounds.north);
  const lastY = row(bounds.south);

  const stitched = new OffscreenCanvas((lastX - firstX + 1) * TILE_SIZE, (lastY - firstY + 1) * TILE_SIZE);
  const context = stitched.getContext("2d")!;
  const reads: Promise<void>[] = [];
  for (let x = firstX; x <= lastX; x++) {
    for (let y = firstY; y <= lastY; y++) {
      reads.push(
        image.getTile(((x % blocks) + blocks) % blocks, y, { signal }).then(async (tile) => {
          // A sparse block, poleward of what any satellite sees, is left transparent.
          if (tile) {
            const bitmap = await createImageBitmap(new Blob([tile.bytes], { type: tile.mimeType }));
            context.drawImage(bitmap, (x - firstX) * TILE_SIZE, (y - firstY) * TILE_SIZE);
            bitmap.close();
          }
        }),
      );
    }
  }
  await Promise.all(reads);

  const source = context.getImageData(0, 0, stitched.width, stitched.height);
  const picture = new ImageData(width, height);
  const columns = Array.from({ length: width }, (_, px) => Math.floor(mercatorX(bounds.west + ((px + 0.5) / width) * (bounds.east - bounds.west), size)) - firstX * TILE_SIZE);
  for (let py = 0; py < height; py++) {
    const sy = Math.floor(mercatorY(bounds.north - ((py + 0.5) / height) * (bounds.north - bounds.south), size)) - firstY * TILE_SIZE;
    if (sy < 0 || sy >= source.height) continue;
    for (let px = 0; px < width; px++) {
      const sx = columns[px]!;
      if (sx < 0 || sx >= source.width) continue;
      const from = (sy * source.width + sx) * 4;
      picture.data.set(source.data.subarray(from, from + 4), (py * width + px) * 4);
    }
  }
  const out = new OffscreenCanvas(width, height);
  out.getContext("2d")!.putImageData(picture, 0, 0);
  return out.convertToBlob({ type: "image/webp", quality: 0.85 });
}
