import { JulianDate } from "@cesium/core";
import { describe, expect, test } from "vitest";

import { type RecutProbe, RecutSchedule } from "./recutSchedule";

const START = JulianDate.fromIso8601("2026-01-01T00:00:00Z");

const at = (seconds: number): JulianDate => JulianDate.addSeconds(START, seconds, new JulianDate());

function probe(overrides: Partial<RecutProbe> = {}): RecutProbe {
  return { count: 1, tracksPending: false, groundTracksSettled: () => true, ...overrides };
}

/** The ticks, counted from 1, on which the corridors were re-cut; each tick 10 s on, so time is never what holds them. */
function groundTrackRecuts(ticks: number, settled: (tick: number) => boolean | undefined): number[] {
  const schedule = new RecutSchedule(START);
  const recuts: number[] = [];
  for (let tick = 1; tick <= ticks; tick++) {
    if (schedule.tick(at(tick * 10), probe({ groundTracksSettled: () => settled(tick) })).groundTracks) {
      recuts.push(tick);
    }
  }
  return recuts;
}

describe("RecutSchedule", () => {
  test("nothing is due without satellites", () => {
    const schedule = new RecutSchedule(START);
    expect(schedule.tick(at(60), probe({ count: 0 }))).toEqual({ tracks: false, groundTracks: false });
  });

  test("both batches are due once the interval has passed, and not before", () => {
    const schedule = new RecutSchedule(START);
    // One satellite re-cuts every second.
    expect(schedule.tick(at(0.5), probe())).toEqual({ tracks: false, groundTracks: false });
    expect(schedule.tick(at(1), probe())).toEqual({ tracks: true, groundTracks: true });
    expect(schedule.tick(at(1.5), probe())).toEqual({ tracks: false, groundTracks: false });
  });

  test("a rebuilding orbit batch holds the interval until it lands", () => {
    const schedule = new RecutSchedule(START);
    expect(schedule.tick(at(1), probe({ tracksPending: true })).tracks).toBe(false);
    expect(schedule.tick(at(2), probe({ tracksPending: true })).tracks).toBe(false);
    // The interval counts from the last tick it was pending.
    expect(schedule.tick(at(2.5), probe()).tracks).toBe(false);
    expect(schedule.tick(at(3), probe()).tracks).toBe(true);
  });

  test("a corridor re-cut that took five ticks to land waits five more", () => {
    // Re-cut on tick 1, landed on tick 6, so rested from tick 11.
    expect(groundTrackRecuts(11, (tick) => tick >= 6)).toEqual([1, 11]);
  });

  test("with no satellite to answer, the corridors are taken to land after 30 ticks", () => {
    expect(groundTrackRecuts(70, () => undefined)).toEqual([1, 61]);
  });
});
