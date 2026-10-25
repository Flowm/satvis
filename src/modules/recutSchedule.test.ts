import { JulianDate } from "@cesium/core";
import { describe, expect, test } from "vitest";

import { type RecutProbe, RecutSchedule } from "./recutSchedule";

const START = JulianDate.fromIso8601("2026-01-01T00:00:00Z");

const at = (seconds: number): JulianDate => JulianDate.addSeconds(START, seconds, new JulianDate());

function probe(overrides: Partial<RecutProbe> = {}): RecutProbe {
  return { count: 1, tracksPending: false, ...overrides };
}

describe("RecutSchedule", () => {
  test("nothing is due without satellites", () => {
    const schedule = new RecutSchedule(START);
    expect(schedule.tick(at(60), probe({ count: 0 }))).toBe(false);
  });

  test("the orbit tracks are due once the interval has passed, and not before", () => {
    const schedule = new RecutSchedule(START);
    // One satellite re-cuts every second.
    expect(schedule.tick(at(0.5), probe())).toBe(false);
    expect(schedule.tick(at(1), probe())).toBe(true);
    expect(schedule.tick(at(1.5), probe())).toBe(false);
  });

  test("a rebuilding orbit batch holds the interval until it lands", () => {
    const schedule = new RecutSchedule(START);
    expect(schedule.tick(at(1), probe({ tracksPending: true }))).toBe(false);
    expect(schedule.tick(at(2), probe({ tracksPending: true }))).toBe(false);
    // The interval counts from the last tick it was pending.
    expect(schedule.tick(at(2.5), probe())).toBe(false);
    expect(schedule.tick(at(3), probe())).toBe(true);
  });
});
