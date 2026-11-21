import { describe, expect, test } from "vitest";

import { orbitReplay, replayPlace, stationReplay } from "./overpassReplay";
import type { Granule, Overpass } from "./util/cmrGranules";

const MINUTE = 60 * 1000;
const station = { latitude: 48, longitude: 11 };

/** An overpass of `count` six-minute granules from `start` minutes. */
function overpass(start: number, count = 2): Overpass {
  const granules = Array.from({ length: count }, (_, index): Granule => {
    const from = (start + 6 * index) * MINUTE;
    return { start: from, end: from + 6 * MINUTE, day: true, outline: [station, station] };
  });
  return { start: granules[0]!.start, end: granules.at(-1)!.end, granules };
}

describe("replayPlace", () => {
  const overpasses = [overpass(100), overpass(200), overpass(300)];
  const plan = (item: Overpass) => stationReplay(item, station);
  const at = (minutes: number) => replayPlace(overpasses, minutes * MINUTE, plan);

  test("at a replay's start, steps to the ones either side of it", () => {
    expect(at(195)).toEqual({ current: overpasses[1], previous: overpasses[0], next: overpasses[2] });
  });

  test("still at an overpass a little after it, then between it and the next", () => {
    expect(at(215).current).toBe(overpasses[1]);
    expect(at(240)).toEqual({ current: undefined, previous: overpasses[1], next: overpasses[2] });
  });

  test("before the first and after the last", () => {
    expect(at(10)).toEqual({ current: undefined, previous: undefined, next: overpasses[0] });
    expect(at(400)).toEqual({ current: undefined, previous: overpasses[2], next: undefined });
  });
});

describe("orbitReplay", () => {
  test("replays an orbit's day side from its middle granule", () => {
    const orbit = overpass(100, 5);
    expect(orbitReplay(orbit).time).toBe(orbit.granules[2]!.start - 20 * MINUTE);
  });
});
