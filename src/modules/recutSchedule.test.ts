import { JulianDate } from "@cesium/core";
import { describe, expect, test } from "vitest";

import { RecutSchedule } from "./recutSchedule";

const START = JulianDate.fromIso8601("2026-01-01T00:00:00Z");

const at = (seconds: number): JulianDate => JulianDate.addSeconds(START, seconds, new JulianDate());

describe("RecutSchedule", () => {
  test("nothing is due without satellites", () => {
    const schedule = new RecutSchedule(START);
    expect(schedule.tick(at(60), 0)).toBe(false);
  });

  test("the orbit tracks are due once the interval has passed, and not before", () => {
    const schedule = new RecutSchedule(START);
    // One satellite re-cuts every second.
    expect(schedule.tick(at(0.5), 1)).toBe(false);
    expect(schedule.tick(at(1), 1)).toBe(true);
    expect(schedule.tick(at(1.5), 1)).toBe(false);
  });
});
