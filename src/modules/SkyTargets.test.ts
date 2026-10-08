import { Cartesian2, Cartesian3, Math as CesiumMath } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { compassPoint, directionToWorld, lookAngles, nearestTarget, observerFrame, type SkyTarget, sunElevation } from "./SkyTargets";
import { sunDirection } from "./util/visibility";

const MUNICH = { lat: 48.14, lon: 11.58 };
const frameAt = (lat: number, lon: number, height = 2) => observerFrame(Cartesian3.fromDegrees(lon, lat, height));

/** Signed, in (-180, 180]: due north can come back as 0 or 359.999…. */
const azimuthError = (actual: number, expected: number): number => Math.abs(((((actual - expected) % 360) + 540) % 360) - 180);

describe("sunElevation", () => {
  const frame = frameAt(MUNICH.lat, MUNICH.lon);
  const at = (epochMs: number) => sunElevation(frame, sunDirection(epochMs, new Cartesian3()));

  test("is 90° less the latitude plus the declination at noon on the June solstice", () => {
    // Local solar noon at 11.58° E, with the equation of time near -1.6 min.
    expect(at(Date.UTC(2026, 5, 21, 11, 15))).toBeCloseTo(90 - MUNICH.lat + 23.436, 0);
  });

  test("is below the horizon at midnight", () => {
    expect(at(Date.UTC(2026, 5, 21, 23, 15))).toBeLessThan(-15);
  });
});

describe("lookAngles", () => {
  const frame = frameAt(MUNICH.lat, MUNICH.lon);

  test("puts a point straight overhead at the zenith", () => {
    const overhead = Cartesian3.fromDegrees(MUNICH.lon, MUNICH.lat, 800_000);
    const { elevation, rangeKm } = lookAngles(frame, overhead);
    // Not exactly 90: the geodetic normal round-trips through the ellipsoid
    // conversion, which costs a fraction of a milliarcsecond.
    expect(elevation).toBeCloseTo(90, 5);
    // Range is the altitude difference, not the altitude.
    expect(rangeKm).toBeCloseTo(800, 1);
  });

  test("reads the cardinal directions off the horizon", () => {
    // Far enough along each bearing to read as it, low enough to stay near the horizon.
    const cases: [number, number, number][] = [
      [MUNICH.lat + 1, MUNICH.lon, 0],
      [MUNICH.lat, MUNICH.lon + 1, 90],
      [MUNICH.lat - 1, MUNICH.lon, 180],
      [MUNICH.lat, MUNICH.lon - 1, 270],
    ];
    for (const [lat, lon, expected] of cases) {
      const { azimuth } = lookAngles(frame, Cartesian3.fromDegrees(lon, lat, 0));
      expect(azimuthError(azimuth, expected), `${lat},${lon}`).toBeLessThan(0.5);
    }
  });

  test("puts the ground below the horizon and orbit above it", () => {
    // A point on the ground 100 km away is below the horizon from 2 m up.
    expect(lookAngles(frame, Cartesian3.fromDegrees(MUNICH.lon, MUNICH.lat + 0.9, 0)).elevation).toBeLessThan(0);
    // Directly overhead at LEO is well above it.
    expect(lookAngles(frame, Cartesian3.fromDegrees(MUNICH.lon, MUNICH.lat, 817_000)).elevation).toBeGreaterThan(80);
  });

  test("round-trips a direction back into the angles it was built from", () => {
    for (const azimuth of [0, 37, 180, 300]) {
      for (const elevation of [0, 15, 60, 89]) {
        const world = directionToWorld(frame, azimuth, elevation, 1e6);
        const back = lookAngles(frame, world);
        expect(azimuthError(back.azimuth, azimuth), `az=${azimuth} el=${elevation}`).toBeLessThan(1e-6);
        expect(back.elevation, `az=${azimuth} el=${elevation}`).toBeCloseTo(elevation, 6);
      }
    }
  });

  test("survives a target sitting exactly on the observer", () => {
    expect(lookAngles(frame, frame.position)).toEqual({ azimuth: 0, elevation: 0, rangeKm: 0 });
  });

  test("works in the southern hemisphere too", () => {
    const sydney = frameAt(-33.87, 151.21);
    const overhead = Cartesian3.fromDegrees(151.21, -33.87, 500_000);
    expect(lookAngles(sydney, overhead).elevation).toBeCloseTo(90, 5);
    expect(azimuthError(lookAngles(sydney, Cartesian3.fromDegrees(151.21, -32.87, 0)).azimuth, 0)).toBeLessThan(0.5);
  });
});

describe("nearestTarget", () => {
  const center = new Cartesian2(640, 360);
  const target = (name: string, x: number, y: number, elevation = 45): SkyTarget =>
    ({ name, azimuth: 0, elevation, rangeKm: 1000, altitudeKm: 800, window: new Cartesian2(x, y), visibility: "visible", sat: { props: { name } } }) as unknown as SkyTarget;

  test("takes the genuinely nearest, not the first in range", () => {
    const targets = [target("far", 640, 410), target("near", 650, 360), target("mid", 660, 380)];
    expect(nearestTarget(targets, center, 60)?.name).toBe("near");
  });

  test("respects the capture radius", () => {
    expect(nearestTarget([target("just in", 640, 419)], center, 60)?.name).toBe("just in");
    expect(nearestTarget([target("just out", 640, 421)], center, 60)).toBeUndefined();
  });

  test("drops what the Earth is in front of", () => {
    // Below the horizon, so occluded.
    expect(nearestTarget([target("underfoot", 641, 360, -5)], center, 60)).toBeUndefined();
    expect(nearestTarget([target("grazing", 641, 360, 0)], center, 60)).toBeUndefined();
  });

  test("ignores anything behind the camera", () => {
    const behind = { ...target("behind", 0, 0), window: undefined };
    expect(nearestTarget([behind], center, 60)).toBeUndefined();
  });

  test("finds nothing in an empty sky", () => {
    expect(nearestTarget([], center, 60)).toBeUndefined();
  });

  test("passes over what the ground hides and takes the next one", () => {
    const targets = [target("behind the ridge", 645, 360), target("in the clear", 640, 380)];
    expect(nearestTarget(targets, center, 60, (t) => t.name === "behind the ridge")?.name).toBe("in the clear");
  });

  test("locks nothing when the ground hides every candidate", () => {
    const targets = [target("one", 645, 360), target("two", 640, 380)];
    expect(nearestTarget(targets, center, 60, () => true)).toBeUndefined();
  });

  test("asks about the nearest first, and stops as soon as one is visible", () => {
    // The predicate is a terrain ray, so the order and the count are the point.
    const asked: string[] = [];
    const targets = [target("third", 640, 390), target("first", 641, 360), target("second", 640, 370)];
    expect(
      nearestTarget(targets, center, 60, (t) => {
        asked.push(t.name);
        return t.name === "first";
      })?.name,
    ).toBe("second");
    expect(asked).toEqual(["first", "second"]);
  });

  test("does not ask about anything the horizon already ruled out", () => {
    const asked: string[] = [];
    const targets = [target("underfoot", 641, 360, -5), target("up there", 640, 380)];
    nearestTarget(targets, center, 60, (t) => {
      asked.push(t.name);
      return false;
    });
    expect(asked).toEqual(["up there"]);
  });
});

describe("compassPoint", () => {
  test("names the sixteen points", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(90)).toBe("E");
    expect(compassPoint(180)).toBe("S");
    expect(compassPoint(270)).toBe("W");
    expect(compassPoint(45)).toBe("NE");
    expect(compassPoint(202.5)).toBe("SSW");
  });

  test("wraps rather than running off the end", () => {
    // 359° is north, not a seventeenth point.
    expect(compassPoint(359)).toBe("N");
    expect(compassPoint(360)).toBe("N");
    expect(compassPoint(-90)).toBe("W");
    expect(compassPoint(720 + 180)).toBe("S");
  });
});

describe("observerFrame", () => {
  test("builds an orthonormal frame", () => {
    const { fixedToEnu } = frameAt(MUNICH.lat, MUNICH.lon);
    // East, north and up recovered from the rows must be unit and mutually
    // perpendicular, or every angle derived from them is skewed.
    const rows = [0, 1, 2].map((i) => new Cartesian3(fixedToEnu[i] as number, fixedToEnu[i + 3] as number, fixedToEnu[i + 6] as number));
    for (const row of rows) {
      expect(Cartesian3.magnitude(row)).toBeCloseTo(1, 12);
    }
    expect(Cartesian3.dot(rows[0] as Cartesian3, rows[1] as Cartesian3)).toBeCloseTo(0, 12);
    expect(Cartesian3.dot(rows[1] as Cartesian3, rows[2] as Cartesian3)).toBeCloseTo(0, 12);
    // Up at the observer points away from the geocentre.
    expect(CesiumMath.toDegrees(Cartesian3.angleBetween(rows[2] as Cartesian3, frameAt(MUNICH.lat, MUNICH.lon).position))).toBeLessThan(0.3);
  });
});
