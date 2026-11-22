// A granule layer's overpasses and granules as its catalogue lists them (ADR 0023): a
// station's, which its passes replay, the newest, which the Imagery tab card goes to, and a
// satellite's around the clock, which the timeline shades. What they show comes from GIBS or
// EUMETView.

import type { GranuleLayer } from "@/config/instrumentImagery";
import { fetchGranules, type Granule, type GroundPoint, groupOverpasses, type Overpass } from "@/modules/util/cmrGranules";

import { gibsHasGranule } from "./GibsImagery";
import { cutHasGranule, picturesEnd } from "./granulePictures";

// Milliseconds.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far back the newest granule is looked for: as long as GIBS keeps a granule layer's frames. */
const LATEST_WITHIN_MS = 90 * DAY;

/** How many of the newest day granules are asked for pixels before giving up: GIBS leaves out about two in five. */
const LATEST_TRIES = 12;

/** How many of the newest granules are listed to find LATEST_TRIES by day: about half are night ones. */
const LATEST_LISTED = 3 * LATEST_TRIES;

/**
 * Degrees from the equator past which a granule is not the one a card pictures: its picture
 * is held within 50° (previewBounds). Sentinel-3's passes end at 84° S in November.
 */
const LATEST_MAX_LATITUDE = 50;

/** How far back a station's overpasses are listed. GIBS keeps 90 days; a month is what a list can show. */
export const STATION_DAYS = 30;

/** Whether the layer's pictures have the granule's pixels; never for a layer of outlines alone. */
export function hasPixels(layer: GranuleLayer, granule: Granule): Promise<boolean> {
  if (layer.pictures === undefined) {
    return Promise.resolve(false);
  }
  if (layer.pictures.frame === "granule" && layer.provider === "gibs") {
    return gibsHasGranule({ layer: layer.layer, maximumLevel: layer.maxLevel, format: layer.format }, granule.start);
  }
  return cutHasGranule(layer.pictures, granule);
}

/** What `layer`'s catalogue is asked for, besides the times. */
export function catalogueQuery(layer: GranuleLayer): { collections: string[]; platform?: string } {
  return { collections: layer.granules, ...(layer.platform !== undefined && { platform: layer.platform }) };
}

/** A layer's newest day granule, and the newest away from the poles, which a card pictures. */
export interface LatestGranules {
  newest: Granule;
  pictured: Granule;
}

/**
 * A layer's newest day granules whose pixels its pictures have, from before their newest
 * frame, or of a layer of outlines its newest day granules; undefined where none of the last
 * few has them or the catalogue does not answer.
 */
export async function latestGranule(layer: GranuleLayer, signal: AbortSignal, now = Date.now()): Promise<LatestGranules | undefined> {
  // Granules newer than the pictures' newest frame would each be asked for in vain.
  const pictured = layer.pictures && (await picturesEnd(layer.pictures, signal));
  const end = Math.min(now, pictured ?? now);
  const granules = await fetchGranules({ ...catalogueQuery(layer), start: end - LATEST_WITHIN_MS, end, newest: LATEST_LISTED }, signal);
  const newest = (granules ?? [])
    .filter((granule) => granule.day)
    .toReversed()
    .slice(0, LATEST_TRIES);
  const answers = layer.pictures === undefined ? newest.map(() => true) : await Promise.all(newest.map((granule) => hasPixels(layer, granule)));
  const had = newest.filter((_, index) => answers[index]);
  if (signal.aborted || had.length === 0) {
    return undefined;
  }
  return { newest: had[0]!, pictured: had.find((granule) => Math.abs(granuleCentre(granule).latitude) <= LATEST_MAX_LATITUDE) ?? had[0]! };
}

/**
 * The overpasses over `point` in the last STATION_DAYS before `now`, by day and by night,
 * oldest first, or undefined where CMR does not answer.
 */
export async function stationOverpasses(layer: GranuleLayer, point: GroundPoint, signal: AbortSignal, now = Date.now()): Promise<Overpass[] | undefined> {
  const granules = await fetchGranules({ ...catalogueQuery(layer), start: now - STATION_DAYS * DAY, end: now, point }, signal);
  return granules && groupOverpasses(granules);
}

/** Some of it sensed by day: a true colour picture has something of it. */
export function isDayOverpass(overpass: Overpass): boolean {
  return overpass.granules.some((granule) => granule.day);
}

/** Where a granule is, roughly: the mean of its outline's corners, across the antimeridian too. */
export function granuleCentre(granule: Granule): GroundPoint {
  const corners = granule.outline.slice(0, -1);
  const first = corners[0]?.longitude ?? 0;
  // Each longitude within 180° of the first, so a granule across the antimeridian is not averaged to the far side.
  const unwrap = (longitude: number) => longitude + 360 * Math.round((first - longitude) / 360);
  const latitude = corners.reduce((sum, corner) => sum + corner.latitude, 0) / corners.length;
  const longitude = corners.reduce((sum, corner) => sum + unwrap(corner.longitude), 0) / corners.length;
  return { latitude, longitude: ((((longitude + 180) % 360) + 360) % 360) - 180 };
}

/** What a replay sets: the clock, its speed, and the satellite and station the camera watches. */
export interface ReplayPlan {
  /** Epoch ms the clock starts at. */
  time: number;
  /** One of the speed ladder's rungs. */
  multiplier: number;
  /** The satellite passing, by name. */
  satellite: string;
  /** The station it passes over. */
  centre: GroundPoint;
}

/** How long before an overpass the clock is set: the satellite comes up to it. */
export const REPLAY_LEAD_MS = 5 * MINUTE;

/** `satellite`'s pass or overpass over a station: from five minutes before it starts, at 30×. */
export function stationReplay(overpass: Pick<Overpass, "start">, station: GroundPoint, satellite: string): ReplayPlan {
  return { time: overpass.start - REPLAY_LEAD_MS, multiplier: 30, satellite, centre: station };
}

/** How far around the clock a satellite's own overpasses are listed for the timeline: a day each way, about 14 orbits. */
const ORBITS_AROUND_MS = DAY;

/**
 * The satellite's overpasses by day from a day before `around` to a day after it, or to
 * `now`, oldest first: each its granules of one orbit's day side. Undefined where CMR does
 * not answer.
 */
export async function orbitOverpasses(layer: GranuleLayer, around: number, signal: AbortSignal, now = Date.now()): Promise<Overpass[] | undefined> {
  const granules = await fetchGranules({ ...catalogueQuery(layer), start: around - ORBITS_AROUND_MS, end: Math.min(now, around + ORBITS_AROUND_MS) }, signal);
  return granules && groupOverpasses(granules.filter((granule) => granule.day));
}

/** How far before its replay's start the clock still counts as at an overpass: a step lands on it a moment early. */
const STEP_SLACK_MS = MINUTE;

/** How long after its end the clock still counts as at an overpass, or at a granule: the fill's slack, and some. */
export const AFTER_OVERPASS_MS = 10 * MINUTE;

/** Where the clock is among a list of replays. */
export interface ReplayPlace<T> {
  /** The one the clock is at, from its replay's start to a little after its end. */
  current: T | undefined;
  previous: T | undefined;
  next: T | undefined;
}

/**
 * Where `time` is among `items`, oldest first, each starting its replay at `plan(item).time`
 * and ending at `item.end`: so a step from one replay goes to the one before or after it.
 * Of items replayed at the same time, as one overpass over two stations, the current is the
 * one `on`, the replay's own.
 */
export function replayPlace<T extends { end: number }>(items: readonly T[], time: number, plan: (item: T) => ReplayPlan, on: (item: T) => boolean = () => true): ReplayPlace<T> {
  const at = items.findLastIndex((item) => on(item) && plan(item).time <= time + STEP_SLACK_MS && time <= item.end + AFTER_OVERPASS_MS);
  if (at >= 0) return { current: items[at], previous: items[at - 1], next: items[at + 1] };
  const begun = items.filter((item) => plan(item).time <= time + STEP_SLACK_MS).length;
  return { current: undefined, previous: items[begun - 1], next: items[begun] };
}
