// Whether a granule's picture, cut from another layer's frame, has anything in it (ADR 0023):
// EUMETView's swaths and orbits, and GIBS's daily layers.

import { type GranulePictures, granulePictureUrl } from "@/config/instrumentImagery";
import { type Granule, granuleExtent, granuleKey } from "@/modules/util/cmrGranules";

import { fetchCapabilities } from "./EumetViewImagery";
import { gibsDays, RECHECK_MS } from "./GibsImagery";

/** A day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far past the newest frame EUMETView's capabilities list its pictures may reach: they
 * list a grid of Sentinel-3A's orbits that drifts from its frames, 45 minutes behind them
 * on 2026-11-22.
 */
const EUMETVIEW_GRID_SLACK_MS = 60 * 60 * 1000;

/** By layer and granule: a granule's pixels, once there, stay; a "no" is forgotten after RECHECK_MS. */
const answers = new Map<string, Promise<boolean>>();

/** Degrees either side of a granule's centre asked for at most: well inside a 3-minute OLCI granule, 11° across. */
const PROBE_HALF_WIDTH = 1;

/** Pixels across the probe; half of them lit is a granule there. */
const PROBE_SIZE = 16;

/** Darker than this in every channel is the black the picture is on, where the frame has no pixels. */
const BLACK = 8;

/**
 * Times a picture is asked for before it counts as missing: GIBS's WMS answers about one
 * small request in five with an empty exception (measured 2026-11-22), and the next one
 * with the picture.
 */
export const PICTURE_TRIES = 3;

/** The pixels of a JPEG brighter than black, or undefined where it cannot be decoded here. */
async function litPixels(picture: Blob): Promise<number | undefined> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    return undefined;
  }
  const bitmap = await createImageBitmap(picture);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (context === null) {
    return undefined;
  }
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) > BLACK) {
      count += 1;
    }
  }
  return count;
}

/** The middle of a granule's extent, its longitude on the globe, and a box a quarter of the granule's size across at most. */
export function probeBounds(granule: Granule): { west: number; south: number; east: number; north: number } {
  const { west, south, east, north } = granuleExtent(granule);
  const longitude = (((((west + east) / 2 + 180) % 360) + 360) % 360) - 180;
  const latitude = (south + north) / 2;
  const half = Math.min(PROBE_HALF_WIDTH, (east - west) / 4, (north - south) / 4);
  // On one side of the antimeridian, where GIBS's WMS draws nothing across it: still within a granule four times as wide.
  const centre = Math.min(180 - half, Math.max(-180 + half, longitude));
  return { west: centre - half, south: latitude - half, east: centre + half, north: latitude + half };
}

/**
 * Whether the frame of `pictures` holding `granule` has its pixels: a small picture around
 * the granule's centre, black where the frame lacks the granule, as Sentinel-3A's swaths
 * lacked most of 2 of 10 on 2026-11-20. A box over the whole granule would also catch its
 * neighbours. False, and asked again later, where the provider cannot be reached.
 */
export function cutHasGranule(pictures: GranulePictures, granule: Granule): Promise<boolean> {
  const key = `${pictures.provider}:${pictures.layer}/${granuleKey(granule)}`;
  let answer = answers.get(key);
  if (answer === undefined) {
    const url = granulePictureUrl(pictures, granule.start, probeBounds(granule), PROBE_SIZE, PROBE_SIZE);
    answer = fetchPicture(url)
      .then(async (picture) => {
        if (picture === undefined) {
          return false;
        }
        const lit = await litPixels(picture).catch(() => undefined);
        return lit === undefined || lit >= (PROBE_SIZE * PROBE_SIZE) / 2;
      })
      .then((has) => {
        if (!has) setTimeout(() => answers.delete(key), RECHECK_MS);
        return has;
      })
      .catch(() => {
        answers.delete(key);
        return false;
      });
    answers.set(key, answer);
  }
  return answer;
}

/** A WMS picture, or undefined where the service answers each of PICTURE_TRIES with an error. Throws where it cannot be reached. */
async function fetchPicture(url: string, tries = PICTURE_TRIES): Promise<Blob | undefined> {
  const response = await fetch(url);
  // Both answer an error as XML, with a success status.
  if (response.ok && response.headers.get("content-type")?.startsWith("image/")) {
    return response.blob();
  }
  return tries > 1 ? fetchPicture(url, tries - 1) : undefined;
}

/**
 * About when the newest frame of `pictures` ends, or undefined where its provider does not
 * say or does not answer. GIBS's daily layers run up to two weeks behind live (PACE's OCI on
 * 2026-11-22), and EUMETView's Sentinel-3 swaths five hours behind the Data Store's granules.
 */
export async function picturesEnd(pictures: GranulePictures, signal: AbortSignal): Promise<number | undefined> {
  if (pictures.frame === "granule") {
    return undefined;
  }
  if (pictures.provider === "gibs") {
    const last = (await gibsDays(pictures.layer, signal))?.at(-1);
    return last && last.end + DAY_MS;
  }
  const last = (await fetchCapabilities(pictures.layer, signal))?.ranges.at(-1);
  return last && last.end + EUMETVIEW_GRID_SLACK_MS;
}
