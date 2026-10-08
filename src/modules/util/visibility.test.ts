import { describe, expect, it } from "vitest";

import { DARK_SKY_SUN_ELEVATION, inEarthShadow, MAX_VISIBLE_RANGE_KM, sunDirection, visibility } from "./visibility";

const degrees = (radians: number) => (radians * 180) / Math.PI;
const declination = (epochMs: number) => degrees(Math.asin(sunDirection(epochMs, { x: 0, y: 0, z: 0 }).z));
/** East of Greenwich, where the sun is overhead. */
const subsolarLongitude = (epochMs: number) => {
  const sun = sunDirection(epochMs, { x: 0, y: 0, z: 0 });
  return degrees(Math.atan2(sun.y, sun.x));
};

describe("sunDirection", () => {
  it("is a unit vector", () => {
    const { x, y, z } = sunDirection(Date.UTC(2026, 9, 8, 18), { x: 0, y: 0, z: 0 });
    expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
  });

  it("stands over the tropic at the June solstice and over the equator at the March equinox", () => {
    // 2026-06-21 08:24 UTC and 2026-03-20 14:46 UTC; the obliquity is 23.436°.
    expect(declination(Date.UTC(2026, 5, 21, 8, 24))).toBeCloseTo(23.436, 1);
    expect(declination(Date.UTC(2026, 2, 20, 14, 46))).toBeCloseTo(0, 1);
  });

  it("crosses Greenwich at solar noon, 16.4 minutes early in early November", () => {
    // The equation of time peaks at +16 min 25 s on 3 November; 0.1° is 24 s of rotation.
    expect(Math.abs(subsolarLongitude(Date.UTC(2026, 10, 3, 11, 43, 35)))).toBeLessThan(0.1);
  });
});

describe("inEarthShadow", () => {
  const sun = { x: 1, y: 0, z: 0 };

  it("holds behind Earth, within one Earth radius of the sun line", () => {
    expect(inEarthShadow({ x: -7e6, y: 0, z: 0 }, sun)).toBe(true);
    expect(inEarthShadow({ x: -7e6, y: 6e6, z: 0 }, sun)).toBe(true);
  });

  it("does not hold on the day side or beside the shadow", () => {
    expect(inEarthShadow({ x: 7e6, y: 0, z: 0 }, sun)).toBe(false);
    expect(inEarthShadow({ x: 0, y: 7e6, z: 0 }, sun)).toBe(false);
    expect(inEarthShadow({ x: -7e6, y: 0, z: 6.5e6 }, sun)).toBe(false);
  });
});

describe("visibility", () => {
  it("needs a lit satellite in a dark sky, near enough to be bright", () => {
    expect(visibility(DARK_SKY_SUN_ELEVATION, true, 1000)).toBe("visible");
    expect(visibility(-20, true, MAX_VISIBLE_RANGE_KM)).toBe("visible");
    expect(visibility(-20, false, 1000)).toBe("shadow");
  });

  it("calls a bright sky daylight, lit or not, near or far", () => {
    expect(visibility(DARK_SKY_SUN_ELEVATION + 0.1, true, 1000)).toBe("daylight");
    expect(visibility(10, false, 1000)).toBe("daylight");
    expect(visibility(10, true, 36_000)).toBe("daylight");
  });

  it("calls a distant satellite far, lit or not", () => {
    expect(visibility(-20, true, 36_000)).toBe("far");
    expect(visibility(-20, false, 36_000)).toBe("far");
  });
});
