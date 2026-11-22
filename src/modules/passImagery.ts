// Passes as what was sensed in them (ADR 0023): a past pass of a satellite with a granule
// layer is the overpass CMR lists over the station, which says whether it was imaged and
// replays it. What is to come is predicted; what is past is recorded, where a record is.

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import type { GranuleLayer } from "@/config/instrumentImagery";
import type { Overpass } from "@/modules/util/cmrGranules";

import type { PassRow } from "./PassPredictor";

dayjs.extend(utc);

/** An overpass CMR lists of one satellite's granule layer over one station. */
export interface RecordedOverpass {
  /** Its satellite, station and layer as one key. */
  pair: string;
  satellite: string;
  station: string;
  layer: GranuleLayer;
  overpass: Overpass;
  /** Some of it sensed by day. */
  day: boolean;
}

/** What a recorded overpass shows: still being asked, its pictures' image of all of it or part, its outline alone, or night. */
export type PassImagery = "asking" | "image" | "part" | "outline" | "night";

/** A row of the Passes table, with the overpass recorded in it. */
export interface PassTableRow extends PassRow {
  recorded?: RecordedOverpass;
}

/** How far apart a predicted pass and a recorded overpass may lie and still be one: as the fill's slack, for today's elements on old granules. */
const MATCH_SLACK_MS = 2 * 60 * 1000;

/** What a pass says of itself, as the predictor gives it. */
interface PassTimes {
  name: string;
  groundStationName?: string;
  start: number;
  end: number;
}

/** The recorded overpass of the pass's satellite over its station that overlaps it most, give or take the slack. */
export function recordedFor(pass: PassTimes, recorded: readonly RecordedOverpass[]): RecordedOverpass | undefined {
  let best: RecordedOverpass | undefined;
  let bestOverlap = Number.NEGATIVE_INFINITY;
  for (const entry of recorded) {
    if (entry.satellite !== pass.name || entry.station !== pass.groundStationName) continue;
    const overlap = Math.min(pass.end, entry.overpass.end) - Math.max(pass.start, entry.overpass.start);
    if (overlap > -MATCH_SLACK_MS && overlap > bestOverlap) {
      best = entry;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * The Passes table: each predicted pass with the overpass recorded in it, and with
 * `showPast` the recorded overpasses by day before `nowMs` that no pass is, as the
 * predictor looks back a day and CMR a month. By start. `subject` names a row: the
 * satellite where a station is selected, the station where a satellite is.
 */
export function passTable(
  rows: readonly PassRow[],
  passes: readonly PassTimes[],
  recorded: readonly RecordedOverpass[],
  { nowMs, showPast, subject }: { nowMs: number; showPast: boolean; subject: "satellite" | "station" },
): PassTableRow[] {
  const used = new Set<RecordedOverpass>();
  const table: PassTableRow[] = rows.map((row, index) => {
    const pass = passes[index]!;
    // Not only passes before the clock: a replay sets the clock back before the pass it replays.
    const match = recordedFor(pass, recorded);
    if (match === undefined) return row;
    used.add(match);
    return { ...row, recorded: match };
  });
  if (!showPast) return table;
  for (const entry of recorded) {
    const { start, end } = entry.overpass;
    // One a pass overlaps is that pass, even where the pass took a closer one.
    if (used.has(entry) || !entry.day || start > nowMs || passes.some((pass) => recordedFor(pass, [entry]) !== undefined)) continue;
    const name = subject === "satellite" ? entry.satellite : entry.station;
    table.push({
      key: `recorded-${name}-${start}`,
      name,
      countdown: end < nowMs ? "ended" : "ongoing",
      startLabel: dayjs.utc(start).format("MM-DD HH:mm:ss"),
      endLabel: dayjs.utc(end).format("HH:mm:ss"),
      // The predictor looks back a day: older passes have no elevation or azimuth.
      primary: "–",
      secondary: "–",
      startMs: start,
      recorded: entry,
    });
  }
  return table.toSorted((a, b) => a.startMs - b.startMs);
}

/** What a recorded overpass shows, from how many of its day granules its pictures have, once asked. */
export function passImagery(entry: RecordedOverpass, pixels: readonly boolean[] | undefined): PassImagery {
  if (!entry.day) return "night";
  if (entry.layer.pictures === undefined) return "outline";
  if (pixels === undefined) return "asking";
  const count = pixels.filter(Boolean).length;
  return count === 0 ? "outline" : count === pixels.length ? "image" : "part";
}
