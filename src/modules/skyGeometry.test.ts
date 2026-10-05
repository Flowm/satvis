import { Cartesian3 } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { enuDirection, levelBasis, normalizeAzimuth, offsetObserver, rollBasis, rollOf } from "./skyGeometry";

const angles = [
  [0, 0],
  [37, 15],
  [180, -30],
  [270, 60],
  [45, 89],
  [300, 90],
] as const;

describe("enuDirection", () => {
  test("names the cardinal directions", () => {
    expect(enuDirection(0, 0)).toMatchObject({ x: expect.closeTo(0, 12), y: expect.closeTo(1, 12), z: expect.closeTo(0, 12) });
    expect(enuDirection(90, 0)).toMatchObject({ x: expect.closeTo(1, 12), y: expect.closeTo(0, 12), z: expect.closeTo(0, 12) });
    expect(enuDirection(0, 90)).toMatchObject({ x: expect.closeTo(0, 12), y: expect.closeTo(0, 12), z: expect.closeTo(1, 12) });
  });

  test("scales by the distance without turning", () => {
    const unit = enuDirection(123, 45);
    const far = enuDirection(123, 45, 1000);
    expect(Cartesian3.magnitude(far)).toBeCloseTo(1000, 9);
    expect(Cartesian3.angleBetween(unit, far)).toBeCloseTo(0, 9);
  });
});

describe("levelBasis", () => {
  test("keeps the horizon level at every elevation", () => {
    for (const [azimuth, elevation] of angles) {
      expect(levelBasis(azimuth, elevation).right.z, `az=${azimuth} el=${elevation}`).toBeCloseTo(0, 12);
    }
  });

  test("is orthonormal against the direction it belongs to", () => {
    for (const [azimuth, elevation] of angles) {
      const direction = enuDirection(azimuth, elevation);
      const { up, right } = levelBasis(azimuth, elevation);
      const label = `az=${azimuth} el=${elevation}`;
      expect(Cartesian3.magnitude(up), label).toBeCloseTo(1, 12);
      expect(Cartesian3.magnitude(right), label).toBeCloseTo(1, 12);
      expect(Cartesian3.dot(direction, up), label).toBeCloseTo(0, 12);
      expect(Cartesian3.dot(direction, right), label).toBeCloseTo(0, 12);
      expect(Cartesian3.dot(up, right), label).toBeCloseTo(0, 12);
    }
  });
});

describe("rollBasis and rollOf", () => {
  // A sign mismatch between the two mirrors the view.
  test("are exact inverses", () => {
    for (const [azimuth, elevation] of angles) {
      for (const roll of [-170, -90, -30, 0, 30, 90, 170]) {
        const { up } = rollBasis(azimuth, elevation, roll);
        expect(rollOf(azimuth, elevation, up), `az=${azimuth} el=${elevation} roll=${roll}`).toBeCloseTo(roll, 9);
      }
    }
  });

  test("reports no roll for the level basis", () => {
    for (const [azimuth, elevation] of angles) {
      expect(rollOf(azimuth, elevation, levelBasis(azimuth, elevation).up), `az=${azimuth} el=${elevation}`).toBeCloseTo(0, 12);
    }
  });

  test("turns the basis about the view axis and nothing else", () => {
    const direction = enuDirection(120, 40);
    const rolled = rollBasis(120, 40, 30);
    expect(Cartesian3.dot(direction, rolled.up)).toBeCloseTo(0, 12);
    expect(Cartesian3.dot(direction, rolled.right)).toBeCloseTo(0, 12);
    expect(Cartesian3.dot(rolled.up, rolled.right)).toBeCloseTo(0, 12);
  });
});

describe("normalizeAzimuth", () => {
  test("wraps onto [0, 360)", () => {
    expect(normalizeAzimuth(0)).toBe(0);
    expect(normalizeAzimuth(360)).toBe(0);
    expect(normalizeAzimuth(-90)).toBe(270);
    expect(normalizeAzimuth(450)).toBe(90);
    expect(normalizeAzimuth(-720.5)).toBeCloseTo(359.5, 9);
  });
});

describe("offsetObserver", () => {
  const MUNICH = { lat: 48.1372, lon: 11.5756 };
  const distance = (from: { lat: number; lon: number }, to: { lat: number; lon: number }): number =>
    Cartesian3.distance(Cartesian3.fromDegrees(from.lon, from.lat), Cartesian3.fromDegrees(to.lon, to.lat));

  test("moves the distance asked for, in the direction asked for", () => {
    expect(offsetObserver(MUNICH, 0, 100).lat).toBeGreaterThan(MUNICH.lat);
    expect(offsetObserver(MUNICH, 100, 0).lon).toBeGreaterThan(MUNICH.lon);
    expect(distance(MUNICH, offsetObserver(MUNICH, 0, 1000))).toBeCloseTo(1000, 1);
    expect(distance(MUNICH, offsetObserver(MUNICH, 750, -750))).toBeCloseTo(Math.hypot(750, 750), 1);
  });

  test("standing still stays put", () => {
    const still = offsetObserver(MUNICH, 0, 0);
    expect(still.lat).toBeCloseTo(MUNICH.lat, 9);
    expect(still.lon).toBeCloseTo(MUNICH.lon, 9);
  });

  test("keeps its scale near the poles, where degrees of longitude do not", () => {
    // 100 m east at 89.9°N is half a degree of longitude: the parallel is 11 km
    // around. A fixed 111,320 m per degree would move 0.0009°.
    const polar = { lat: 89.9, lon: 0 };
    expect(distance(polar, offsetObserver(polar, 100, 0))).toBeCloseTo(100, 1);
    expect(offsetObserver(polar, 100, 0).lon).toBeCloseTo(0.513, 2);
  });

  test("crosses the antimeridian without wrapping arithmetic", () => {
    const east = { lat: 0, lon: 179.9999 };
    const crossed = offsetObserver(east, 1000, 0);
    expect(crossed.lon).toBeLessThan(-179.9);
    expect(distance(east, crossed)).toBeCloseTo(1000, 1);
  });

  test("walks over the pole rather than off the top of the coordinates", () => {
    const near = { lat: 89.999, lon: 0 };
    const over = offsetObserver(near, 0, 1000);
    expect(over.lat).toBeLessThanOrEqual(90);
    expect(Math.abs(over.lon)).toBeCloseTo(180, 3);
    expect(distance(near, over)).toBeCloseTo(1000, 1);
  });
});
