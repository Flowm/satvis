import { afterEach, describe, expect, test, vi } from "vitest";

import { latestGranule, replayPlace, stationReplay } from "./overpassReplay";
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
  const plan = (item: Overpass) => stationReplay(item, station, "NOAA 20 (JPSS-1)");
  const at = (minutes: number) => replayPlace(overpasses, minutes * MINUTE, plan);

  test("at a replay's start, steps to the ones either side of it", () => {
    expect(at(195)).toEqual({ current: overpasses[1], previous: overpasses[0], next: overpasses[2] });
  });

  test("still at an overpass a little after it, then between it and the next", () => {
    expect(at(215).current).toBe(overpasses[1]);
    expect(at(240)).toEqual({ current: undefined, previous: overpasses[1], next: overpasses[2] });
  });

  test("of two replayed at once, the replay's own is current, so a step leaves it", () => {
    const twins = [overpasses[0]!, { ...overpasses[1]! }, overpasses[1]!, overpasses[2]!];
    const first = replayPlace(twins, 195 * MINUTE, plan, (item) => item === twins[1]);
    expect(first).toEqual({ current: twins[1], previous: twins[0], next: twins[2] });
    const second = replayPlace(twins, 195 * MINUTE, plan, (item) => item === twins[2]);
    expect(second).toEqual({ current: twins[2], previous: twins[1], next: twins[3] });
  });

  test("before the first and after the last", () => {
    expect(at(10)).toEqual({ current: undefined, previous: undefined, next: overpasses[0] });
    expect(at(400)).toEqual({ current: undefined, previous: overpasses[2], next: undefined });
  });
});

describe("latestGranule", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Sentinel-3A's last granules of a pass on 2026-11-21, as CMR answered: the newest near the pole. */
  const feed = {
    feed: {
      entry: [
        ["2026-11-21T01:53:59Z", "-72.49 39.93 -71.41 9.66 -81.35 -19.25 -83.91 55.64 -72.49 39.93"],
        ["2026-11-21T01:41:59Z", "-41.51 104.84 -51.32 98.14 -55.51 116.69 -45.05 120.31 -41.51 104.84"],
        ["2026-11-21T01:38:59Z", "-31.37 109.61 -41.50 104.84 -45.04 120.31 -34.52 123.16 -31.37 109.61"],
      ].map(([start, ring]) => ({
        collection_concept_id: "C1577017384-OB_DAAC",
        time_start: start,
        time_end: new Date(Date.parse(start!) + 3 * MINUTE).toISOString(),
        day_night_flag: "DAY",
        polygons: [[ring]],
      })),
    },
  };

  test("pictures the newest granule away from the poles", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(feed)));
    const layer = { token: "cmr:OLCIS3A_L1_EFR", provider: "cmr" as const, layer: "OLCIS3A_L1_EFR", granules: ["C1577017384-OB_DAAC"] };
    const granules = await latestGranule(layer, new AbortController().signal, Date.parse("2026-11-22T00:00:00Z"));
    expect(granules?.newest.start).toBe(Date.parse("2026-11-21T01:53:59Z"));
    expect(granules?.pictured.start).toBe(Date.parse("2026-11-21T01:41:59Z"));
  });
});
