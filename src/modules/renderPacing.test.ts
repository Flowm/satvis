import { describe, expect, test } from "vitest";

import { DEFAULT_LIMITS, angularRate, distanceToShell, maxPixelsPerRadian, renderTimeChange } from "./renderPacing";

describe("angularRate", () => {
  test("is speed over distance at the nearest approach within the horizon", () => {
    expect(angularRate(20_000_000, 8_000, 0)).toBeCloseTo(4e-4);
    expect(angularRate(20_000_000, 8_000, 1_000)).toBeCloseTo(8_000 / 12_000_000);
  });

  test("is infinite for something that could reach the camera", () => {
    expect(angularRate(5_000, 8_000, 1)).toBe(Infinity);
  });
});

describe("maxPixelsPerRadian", () => {
  test("is the focal length at the centre of a square view, more towards its corners", () => {
    const focal = 500 / Math.tan(Math.PI / 6);
    // tan²θ at the corner of a 1000 × 1000 view: (√2 · 500 / f)².
    expect(maxPixelsPerRadian(1000, 1000, Math.PI / 3)).toBeCloseTo(focal * (1 + ((Math.SQRT2 * 500) / focal) ** 2));
    expect(maxPixelsPerRadian(1000, 1000, Math.PI / 3)).toBeGreaterThan(focal);
  });

  test("takes the field of view along the longer side, as Cesium does", () => {
    expect(maxPixelsPerRadian(2000, 1000, 1)).toBeCloseTo(maxPixelsPerRadian(1000, 2000, 1));
  });
});

describe("distanceToShell", () => {
  test("is the gap to the shell from outside, from inside, and zero within it", () => {
    expect(distanceToShell(25_000, 6_700, 7_100)).toBe(17_900);
    expect(distanceToShell(6_400, 6_700, 7_100)).toBe(300);
    expect(distanceToShell(6_900, 6_700, 7_100)).toBe(0);
  });
});

describe("renderTimeChange", () => {
  // The default view on an iPad mini 6: 2266 × 1218 device pixels, Cesium's 60°.
  const pixelsPerRadian = maxPixelsPerRadian(2266, 1218, Math.PI / 3);

  test("waits over a third of a second at the default view, where a LEO satellite may cross 1.3 pixels a second", () => {
    const leo = angularRate(18_000_000, 8_300, DEFAULT_LIMITS.ceiling);
    expect(leo * pixelsPerRadian).toBeCloseTo(1.29, 1);
    expect(renderTimeChange(leo, pixelsPerRadian)).toBeGreaterThan(1 / 3);
  });

  test("keeps today's 1/30 s near a satellite", () => {
    expect(renderTimeChange(angularRate(50_000, 8_000, 1), pixelsPerRadian)).toBe(DEFAULT_LIMITS.floor);
  });

  test("waits the ceiling when nothing moves, and the floor when the bound is not a number", () => {
    expect(renderTimeChange(0, pixelsPerRadian)).toBe(DEFAULT_LIMITS.ceiling);
    expect(renderTimeChange(Infinity, pixelsPerRadian)).toBe(DEFAULT_LIMITS.floor);
    expect(renderTimeChange(Number.NaN, pixelsPerRadian)).toBe(DEFAULT_LIMITS.floor);
  });
});
