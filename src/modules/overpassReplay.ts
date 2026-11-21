// A granule layer's overpasses and granules as CMR lists them (ADR 0023): a station's, which
// its passes replay, the newest, which the Imagery tab card goes to, and a satellite's around
// the clock, which the timeline shades. What they show comes from GIBS.

import type { GranuleLayer } from "@/config/instrumentImagery";
import { fetchGranules, type Granule, type GroundPoint, groupOverpasses, type Overpass } from "@/modules/util/cmrGranules";

import { gibsHasGranule } from "./GibsImagery";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far back the newest granule is looked for: the near-real-time collection lists one about three hours after it is sensed. */
const LATEST_WITHIN_MS = 12 * HOUR;

/** How many of the newest day granules are asked for pixels before giving up: GIBS leaves out about two in five. */
const LATEST_TRIES = 12;

/** How far back a station's overpasses are listed. GIBS keeps 90 days; a month is what a list can show. */
export const STATION_DAYS = 30;

/** Whether GIBS has the granule's pixels; never for a `cmr` layer, of outlines alone. */
export function hasPixels(layer: GranuleLayer, granule: Granule): Promise<boolean> {
  return layer.provider === "cmr" ? Promise.resolve(false) : gibsHasGranule({ layer: layer.layer, maximumLevel: layer.maxLevel, format: layer.format }, granule.start);
}

/**
 * The newest day granule whose pixels GIBS has, or of a `cmr` layer the newest day
 * granule; undefined where none of the last few has them or CMR does not answer.
 */
export async function latestGranule(layer: GranuleLayer, signal: AbortSignal, now = Date.now()): Promise<Granule | undefined> {
  const granules = await fetchGranules({ collections: layer.granules, start: now - LATEST_WITHIN_MS, end: now }, signal);
  const newest = (granules ?? [])
    .filter((granule) => granule.day)
    .toReversed()
    .slice(0, LATEST_TRIES);
  if (layer.provider === "cmr") {
    return signal.aborted ? undefined : newest[0];
  }
  const answers = await Promise.all(newest.map((granule) => hasPixels(layer, granule)));
  return signal.aborted ? undefined : newest[answers.indexOf(true)];
}

/**
 * The overpasses over `point` in the last STATION_DAYS before `now`, by day and by night,
 * oldest first, or undefined where CMR does not answer.
 */
export async function stationOverpasses(layer: GranuleLayer, point: GroundPoint, signal: AbortSignal, now = Date.now()): Promise<Overpass[] | undefined> {
  const granules = await fetchGranules({ collections: layer.granules, start: now - STATION_DAYS * DAY, end: now, point }, signal);
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

/** What a replay sets: the clock, its speed, and where the camera looks down from. */
export interface ReplayPlan {
  /** Epoch ms the clock starts at. */
  time: number;
  /** One of the speed ladder's rungs. */
  multiplier: number;
  centre: GroundPoint;
}

/** How long before an overpass the clock is set: the satellite comes up to it. */
export const REPLAY_LEAD_MS = 5 * MINUTE;

/** A pass or an overpass over a station: from five minutes before it starts, at 30×, above the station. */
export function stationReplay(overpass: Pick<Overpass, "start">, station: GroundPoint): ReplayPlan {
  return { time: overpass.start - REPLAY_LEAD_MS, multiplier: 30, centre: station };
}

/** How far around the clock a satellite's own overpasses are listed for the timeline: a day each way, about 14 orbits. */
const ORBITS_AROUND_MS = DAY;

/**
 * The satellite's overpasses by day from a day before `around` to a day after it, or to
 * `now`, oldest first: each its granules of one orbit's day side. Undefined where CMR does
 * not answer.
 */
export async function orbitOverpasses(layer: GranuleLayer, around: number, signal: AbortSignal, now = Date.now()): Promise<Overpass[] | undefined> {
  const granules = await fetchGranules({ collections: layer.granules, start: around - ORBITS_AROUND_MS, end: Math.min(now, around + ORBITS_AROUND_MS) }, signal);
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
 */
export function replayPlace<T extends { end: number }>(items: readonly T[], time: number, plan: (item: T) => ReplayPlan): ReplayPlace<T> {
  const begun = items.filter((item) => plan(item).time <= time + STEP_SLACK_MS).length;
  const last = items[begun - 1];
  const current = last !== undefined && time <= last.end + AFTER_OVERPASS_MS ? last : undefined;
  return { current, previous: items[current === undefined ? begun - 1 : begun - 2], next: items[begun] };
}
