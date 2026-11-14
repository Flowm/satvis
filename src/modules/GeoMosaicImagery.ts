// The geostationary Mosaic frame by frame (FramedImagery.ts): one cloud-optimized GeoTIFF
// an hour, the four geostationary satellites joined on one Web Mercator grid, made by the
// georing-mosaic project and read straight from its bucket. Its static STAC collection
// lists the Slots, an item each.

import { type CogFile, CogImageryProvider } from "./CogImageryProvider";
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
async function fetchItems(signal: AbortSignal): Promise<Map<number, string>> {
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

/** The newest complete Slot's item, which `latest.json` names. */
async function latestFile(): Promise<CogFile> {
  const latest = await fetchJson<{ item: string }>(`${BUCKET}/latest.json`);
  return itemFile(new URL(latest.item, `${BUCKET}/`).href);
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
