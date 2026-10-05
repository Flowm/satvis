import { describe, expect, test } from "vitest";

import {
  CHIP_PX,
  clampMagnitude,
  clockLabel,
  dateLabel,
  decayVelocity,
  MAX_SCRUB_VELOCITY,
  MS_PER_PX,
  multiplierLabel,
  nearestRung,
  rateLabel,
  REAL_TIME_RUNG,
  passMarks,
  timelineTicks,
  rungFor,
  LADDER,
  SPEED_TICKS,
} from "./clockDeck";

const AT = new Date("2026-08-19T14:37:09Z");

describe("the speed ladder", () => {
  test("runs from full reverse to full forward through real time", () => {
    expect(LADDER).toHaveLength(SPEED_TICKS.length * 2);
    expect(LADDER[0]).toBe(-86400);
    expect(LADDER.at(-1)).toBe(86400);
    expect(LADDER[REAL_TIME_RUNG]).toBe(1);
    expect(LADDER[REAL_TIME_RUNG - 1]).toBe(-1);
  });

  test("has no rung slower than real time, in either direction", () => {
    expect(LADDER.every((rung) => Math.abs(rung) >= 1)).toBe(true);
  });

  test("finds the nearest rung for a speed nothing on the ladder set", () => {
    expect(LADDER[rungFor(1)]).toBe(1);
    expect(LADDER[rungFor(70)]).toBe(60);
    expect(LADDER[rungFor(-500)]).toBe(-600);
    expect(LADDER[rungFor(1e9)]).toBe(86400);
  });

  test("reads the rung under the needle from the scroll offset", () => {
    expect(nearestRung(0)).toBe(0);
    expect(nearestRung(REAL_TIME_RUNG * CHIP_PX)).toBe(REAL_TIME_RUNG);
    expect(nearestRung(REAL_TIME_RUNG * CHIP_PX + CHIP_PX * 0.7)).toBe(REAL_TIME_RUNG + 1);
    expect(nearestRung(-500)).toBe(0);
    expect(nearestRung(1e6)).toBe(LADDER.length - 1);
  });
});

describe("labels", () => {
  test("say the multiplier with a real minus sign", () => {
    expect(multiplierLabel(1)).toBe("1×");
    expect(multiplierLabel(86400)).toBe("86400×");
    expect(multiplierLabel(-60)).toBe("−60×");
  });

  test("say the rate in the largest unit that keeps it small", () => {
    expect(rateLabel(1)).toBe("1 s/s");
    expect(rateLabel(30)).toBe("30 s/s");
    expect(rateLabel(60)).toBe("1 min/s");
    expect(rateLabel(90)).toBe("1.5 min/s");
    expect(rateLabel(3600)).toBe("1 h/s");
    expect(rateLabel(86400)).toBe("1 d/s");
    expect(rateLabel(-7200)).toBe("−2 h/s");
  });

  test("read the clock in UTC whatever the machine's zone is", () => {
    expect(clockLabel(AT)).toBe("14:37:09");
    expect(dateLabel(AT)).toBe("Wed 19 Aug");
  });
});

describe("the ruler", () => {
  test("centres the clock's moment under the needle", () => {
    const ticks = timelineTicks(AT.getTime(), 360);
    const centre = ticks.reduce((best, tick) => (Math.abs(tick.x - 180) < Math.abs(best.x - 180) ? tick : best));
    expect(Math.abs(centre.at - AT.getTime())).toBeLessThanOrEqual(300_000);
  });

  test("covers the width it is given, at the scale it promises", () => {
    const ticks = timelineTicks(AT.getTime(), 360);
    const step = 600_000 / MS_PER_PX;
    // Ticks land on ten-minute boundaries, so neither end may be short by more than one step.
    expect(ticks[0]!.x).toBeLessThanOrEqual(0);
    expect(ticks.at(-1)!.x).toBeGreaterThan(360 - step);
    expect(3_600_000 / MS_PER_PX).toBe(150);
  });

  test("labels the hour, and names the day at midnight", () => {
    const midnight = Date.UTC(2026, 7, 19, 0, 0, 0);
    const ticks = timelineTicks(midnight, 360);
    const labelled = ticks.filter((tick) => tick.label !== "");
    expect(labelled.every((tick) => tick.major)).toBe(true);
    expect(ticks.find((tick) => tick.at === midnight)?.label).toBe("Wed 19 Aug");
    expect(ticks.find((tick) => tick.at === midnight + 3_600_000)?.label).toBe("01:00");
    expect(ticks.find((tick) => tick.at === midnight + 600_000)?.label).toBe("");
  });

  test("draws more ticks for a wider ruler and none beyond it", () => {
    const narrow = timelineTicks(AT.getTime(), 320);
    const wide = timelineTicks(AT.getTime(), 900);
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(narrow.every((tick) => tick.x >= -600 && tick.x <= 920)).toBe(true);
  });
});

describe("pass bands on the ruler", () => {
  const NOON = Date.UTC(2026, 7, 19, 12, 0, 0);
  const span = (startMin: number, endMin: number) => ({ start: NOON + startMin * 60_000, end: NOON + endMin * 60_000 });

  test("puts a pass where its minutes are", () => {
    // 360 px is 2.4 hours: 10:48 to 13:12.
    const [band] = passMarks([span(0, 10)], NOON, 360);
    expect(band!.left).toBe(180);
    expect(band!.width).toBe((10 * 60_000) / MS_PER_PX);
  });

  test("leaves out what is not on screen, and clips what is half on", () => {
    const bands = passMarks([span(-600, -500), span(-90, 10)], NOON, 360);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.left).toBe(0);
    expect(bands[0]!.left + bands[0]!.width).toBeCloseTo(180 + (10 * 60_000) / MS_PER_PX, 6);
  });

  test("keeps a pass that swallows the whole ruler", () => {
    const [band] = passMarks([span(-6000, 6000)], NOON, 360);
    expect(band).toEqual({ key: expect.any(String), left: 0, width: 360 });
  });

  test("never draws a band nobody can see", () => {
    const [band] = passMarks([span(0, 0)], NOON, 360);
    expect(band!.width).toBe(1);
  });
});

describe("flick physics", () => {
  test("clamps a velocity two events in the same millisecond would produce", () => {
    // `dt` is floored at 1 ms, so an unclamped 40 px drag reads as 40 px/ms.
    expect(clampMagnitude((40 * MS_PER_PX) / 1, MAX_SCRUB_VELOCITY)).toBe(MAX_SCRUB_VELOCITY);
    expect(clampMagnitude(-1e9, MAX_SCRUB_VELOCITY)).toBe(-MAX_SCRUB_VELOCITY);
    expect(clampMagnitude(1000, MAX_SCRUB_VELOCITY)).toBe(1000);
  });

  test("decays toward a stop, at a rate that does not depend on the frame rate", () => {
    const oneFrame = decayVelocity(100, 16.7);
    const twoHalfFrames = decayVelocity(decayVelocity(100, 8.35), 8.35);
    expect(oneFrame).toBeCloseTo(94, 5);
    expect(twoHalfFrames).toBeCloseTo(oneFrame, 10);
    // A second of coasting keeps about a fortieth of the throw.
    expect(decayVelocity(100, 1000)).toBeLessThan(3);
    expect(decayVelocity(100, 1000)).toBeLessThan(decayVelocity(100, 500));
  });
});
