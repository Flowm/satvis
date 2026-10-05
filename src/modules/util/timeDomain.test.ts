import { describe, expect, test } from "vitest";

import { formatFrame, frameWindow, parseDomain, snapToFrame } from "./timeDomain";

const at = (iso: string) => Date.parse(iso);
const TEN_MINUTES = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// Two runs of 10-minute frames with a gap, as GIBS publishes GOES-East.
const GOES = parseDomain("2026-10-04T20:00:00Z/2026-10-04T23:50:00Z/PT10M,2026-10-05T01:00:00Z/2026-10-05T11:20:00Z/PT10M");

describe("parseDomain", () => {
  test("reads ranges, single frames and date-only starts, sorted", () => {
    expect(parseDomain("2026-10-05/2026-10-05T11:30:00Z/PT10M,2015-11-24/2022-07-27/P1D,2016-01-01")).toEqual([
      { start: at("2015-11-24"), end: at("2022-07-27"), step: DAY },
      { start: at("2016-01-01"), end: at("2016-01-01"), step: 0 },
      { start: at("2026-10-05"), end: at("2026-10-05T11:30:00Z"), step: TEN_MINUTES },
    ]);
  });

  test("skips what it cannot read rather than guessing", () => {
    expect(parseDomain("nonsense,2026-10-05/2026-10-04/PT10M,2026-10-04/2026-10-05/P1Y,2026-10-04/2026-10-05/PT")).toEqual([]);
  });
});

describe("snapToFrame", () => {
  test("rounds down to the frame at or before the time", () => {
    expect(snapToFrame(GOES, at("2026-10-05T11:13:00Z"))).toBe(at("2026-10-05T11:10:00Z"));
    expect(snapToFrame(GOES, at("2026-10-05T11:10:00Z"))).toBe(at("2026-10-05T11:10:00Z"));
  });

  test("holds the last frame before a gap", () => {
    expect(snapToFrame(GOES, at("2026-10-05T00:30:00Z"))).toBe(at("2026-10-04T23:50:00Z"));
  });

  test("clamps to the latest frame after the data and the earliest before it", () => {
    expect(snapToFrame(GOES, at("2026-10-06T00:00:00Z"))).toBe(at("2026-10-05T11:20:00Z"));
    expect(snapToFrame(GOES, at("2026-01-01T00:00:00Z"))).toBe(at("2026-10-04T20:00:00Z"));
  });

  test("has no frame for an empty domain", () => {
    expect(snapToFrame([], at("2026-10-05T00:00:00Z"))).toBeUndefined();
  });
});

describe("frameWindow", () => {
  test("is one step per frame, aligned to the step", () => {
    const steps = frameWindow(GOES, at("2026-10-05T11:03:00Z"), TEN_MINUTES, 2);
    expect(steps).toEqual([
      { start: at("2026-10-05T10:40:00Z"), frame: at("2026-10-05T10:40:00Z") },
      { start: at("2026-10-05T10:50:00Z"), frame: at("2026-10-05T10:50:00Z") },
      { start: at("2026-10-05T11:00:00Z"), frame: at("2026-10-05T11:00:00Z") },
      { start: at("2026-10-05T11:10:00Z"), frame: at("2026-10-05T11:10:00Z") },
      { start: at("2026-10-05T11:20:00Z"), frame: at("2026-10-05T11:20:00Z") },
    ]);
  });

  // Every step after the latest frame shows it, so the live clock does not cause a
  // reload every ten minutes while GIBS has nothing newer.
  test("merges the steps that show the same frame", () => {
    const steps = frameWindow(GOES, at("2026-10-05T11:40:00Z"), TEN_MINUTES, 3);
    expect(steps.map((step) => formatFrame(step.frame, false))).toEqual(["2026-10-05T11:10:00Z", "2026-10-05T11:20:00Z"]);
    expect(steps[1]!.start).toBe(at("2026-10-05T11:20:00Z"));
  });

  test("is empty without a domain", () => {
    expect(frameWindow([], at("2026-10-05T00:00:00Z"), DAY, 3)).toEqual([]);
  });
});

describe("formatFrame", () => {
  test("names daily frames by date and others to the second", () => {
    expect(formatFrame(at("2026-10-05T00:00:00Z"), true)).toBe("2026-10-05");
    expect(formatFrame(at("2026-10-05T11:20:00Z"), false)).toBe("2026-10-05T11:20:00Z");
  });
});
