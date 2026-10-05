// Ground station list edits for `setGroundStations`. Each returns a fresh list of
// fresh stations: the store compares against what it holds, so an in-place edit is
// invisible to it. The order decides where the sky view stands (docs/adr/0003-sky-view.md).

import type { SerializedGroundStation } from "../../stores/sat";

export const MAX_LATITUDE = 90;
export const MAX_LONGITUDE = 180;

/**
 * Undefined for half-typed (`-`, `48.`) and invalid (`500`, `banana`) text alike:
 * the store drops what it cannot use, which would make the row vanish mid-typing.
 * `Number`, not `parseFloat`, which reads `48abc` as 48.
 */
export function parseCoordinate(text: string, limit: number): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    return undefined;
  }
  return value;
}

/** Rounded, not floored, so a row swaps once it passes its neighbour's halfway point. */
export function dropIndex(from: number, deltaY: number, rowHeight: number, count: number): number {
  if (rowHeight <= 0) {
    return from;
  }
  // Away from zero: `Math.round` breaks ties toward +∞, so a drag up would not
  // mirror the same drag down.
  const rows = deltaY / rowHeight;
  const target = from + Math.sign(rows) * Math.round(Math.abs(rows));
  return Math.min(Math.max(target, 0), count - 1);
}

/** How far row `index` moves, in pixels, to open a gap where the dragged row lands. The dragged row returns 0: it follows the pointer. */
export function dragShift(index: number, from: number, to: number, rowHeight: number): number {
  if (index === from) {
    return 0;
  }
  if (from < to && index > from && index <= to) {
    return -rowHeight;
  }
  if (from > to && index >= to && index < from) {
    return rowHeight;
  }
  return 0;
}

function copies(stations: readonly SerializedGroundStation[]): SerializedGroundStation[] {
  const next: SerializedGroundStation[] = [];
  for (const station of stations) {
    next.push({ ...station });
  }
  return next;
}

/** Unchanged if the move would leave the list. */
export function moved(stations: readonly SerializedGroundStation[], index: number, by: number): SerializedGroundStation[] {
  const next = copies(stations);
  const to = index + by;
  if (index < 0 || index >= next.length || to < 0 || to >= next.length) {
    return next;
  }
  const [station] = next.splice(index, 1);
  if (station) {
    next.splice(to, 0, station);
  }
  return next;
}

export function without(stations: readonly SerializedGroundStation[], index: number): SerializedGroundStation[] {
  const next = copies(stations);
  if (index < 0 || index >= next.length) {
    return next;
  }
  next.splice(index, 1);
  return next;
}

/** The observer index after `moved(stations, index, by)`: the designation follows the station, not the rank. */
export function observerAfterMove(observer: number, index: number, by: number, count: number): number {
  const to = index + by;
  if (index < 0 || index >= count || to < 0 || to >= count) {
    return observer;
  }
  if (observer === index) {
    return to;
  }
  if (index < observer && observer <= to) {
    return observer - 1;
  }
  if (to <= observer && observer < index) {
    return observer + 1;
  }
  return observer;
}

/** The observer index after `without(stations, index)`. Removing the observer hands it to the first station. */
export function observerAfterRemoval(observer: number, index: number, count: number): number {
  if (index < 0 || index >= count) {
    return observer;
  }
  if (observer === index) {
    return 0;
  }
  return index < observer ? observer - 1 : observer;
}

/** An empty name deletes the key, so the url carries no trailing separator. */
export function renamed(stations: readonly SerializedGroundStation[], index: number, name: string): SerializedGroundStation[] {
  const next = copies(stations);
  const station = next[index];
  if (!station) {
    return next;
  }
  const trimmed = name.trim();
  if (trimmed === "") {
    delete station.name;
  } else {
    station.name = trimmed;
  }
  return next;
}

export function relocated(stations: readonly SerializedGroundStation[], index: number, field: "lat" | "lon", value: number): SerializedGroundStation[] {
  const next = copies(stations);
  const station = next[index];
  if (station) {
    station[field] = value;
  }
  return next;
}

/** Both coordinates at once, so a sky-view walk never stands between the old and new place for a tick. */
export function repositioned(stations: readonly SerializedGroundStation[], index: number, lat: number, lon: number): SerializedGroundStation[] {
  const next = copies(stations);
  const station = next[index];
  if (station) {
    station.lat = lat;
    station.lon = lon;
  }
  return next;
}
