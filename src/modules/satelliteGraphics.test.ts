import { Cartesian3, FixedFrameTransforms, HeadingPitchRoll, Math as CesiumMath, Matrix3, Quaternion } from "@cesium/core";
import { SceneMode } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { SCENE_MODES, SKY_MODE } from "@/config/viewModes";

import {
  cesiumSceneMode,
  coneDescription,
  coneOrientation,
  fanOrientation,
  fanShape,
  groundTrackSwath,
  isLeo,
  modelUrl,
  nadirAngle,
  orbitPathTimes,
  orbitTrackTimes,
  orbitUsesPathGraphic,
  scanPlane,
  GEOMETRY_REFRESH_MAX_SECONDS,
  GEOMETRY_REFRESH_MIN_SECONDS,
  geometryRefreshSeconds,
} from "./satelliteGraphics";

const ISS_PERIOD_MIN = 92.6;

describe("isLeo", () => {
  test("gates on the orbit class itself, so it cannot disagree with the label", () => {
    expect(isLeo("LEO")).toBe(true);
    expect(isLeo("MEO")).toBe(false);
    expect(isLeo("GEO")).toBe(false);
    // A highly elliptical orbit can have a short period.
    expect(isLeo("HEO")).toBe(false);
  });
});

describe("orbit path times", () => {
  test("path leads and trails half a period plus overlap", () => {
    const { leadTime, trailTime } = orbitPathTimes(ISS_PERIOD_MIN);
    expect(leadTime).toBeCloseTo((ISS_PERIOD_MIN * 60) / 2 + 5);
    expect(trailTime).toBe(leadTime);
  });

  test("track leads one full period with no trail", () => {
    expect(orbitTrackTimes(ISS_PERIOD_MIN)).toEqual({ leadTime: ISS_PERIOD_MIN * 60, trailTime: 0 });
  });
});

describe("groundTrackSwath", () => {
  test("keeps each side's extent, in metres", () => {
    expect(groundTrackSwath("LEO", { starboardKm: 200, portKm: 90 })).toEqual({ starboardMeters: 200000, portMeters: 90000 });
  });

  test("is unavailable for non-LEO satellites", () => {
    expect(groundTrackSwath("GEO", { starboardKm: 145, portKm: 145 })).toBeUndefined();
  });
});

describe("coneDescription", () => {
  test("converts the FOV to a half angle in radians", () => {
    const description = coneDescription("LEO", 45);
    expect(description).toBeDefined();
    expect(description!.radiusMeters).toBe(1000000);
    expect(description!.innerHalfAngleRad).toBe(0);
    expect(description!.outerHalfAngleRad).toBeCloseTo(Math.PI / 4);
  });

  test("is unavailable for non-LEO satellites", () => {
    expect(coneDescription("GEO", 45)).toBeUndefined();
  });
});

describe("coneOrientation", () => {
  // Over Europe at ISS altitude.
  const overhead = Cartesian3.fromDegrees(11.5, 48.1, 420000);

  test("orients the cone from a known position", () => {
    const orientation = coneOrientation(overhead);
    expect(orientation).toBeDefined();
    // A rotation, not a degenerate quaternion.
    expect(Quaternion.magnitude(orientation!)).toBeCloseTo(1);
  });

  test("declines rather than throwing when there is no position", () => {
    expect(() => coneOrientation(undefined)).not.toThrow();
    expect(coneOrientation(undefined)).toBeUndefined();
  });

  // If a Cesium upgrade tolerates a missing origin, this fails and the guard can go.
  test("Cesium really does throw on the position the guard withholds", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => FixedFrameTransforms.headingPitchRollQuaternion(undefined as any, new HeadingPitchRoll(0, Math.PI, 0))).toThrow(/origin is required/);
  });
});

describe("swath fan", () => {
  const VIIRS = { starboardKm: 1565, portKm: 1565 };
  // NOAA 20's height, over the equator.
  const above = Cartesian3.fromDegrees(0, 0, 830_000);
  const north = Cartesian3.fromDegrees(0, 0.1, 830_000);
  const axis = (orientation: Quaternion, column: number) => Matrix3.getColumn(Matrix3.fromQuaternion(orientation), column, new Cartesian3());

  test("reaches VIIRS's swath edges at its scan angle, 56° off nadir", () => {
    expect(CesiumMath.toDegrees(nadirAngle(1_565_000, 830_000, 6_378_137))).toBeCloseTo(56.5, 0);
    const shape = fanShape(VIIRS, above)!;
    expect(CesiumMath.toDegrees(shape.xHalfAngleRad)).toBeCloseTo(56.5, 0);
    expect(shape.rollRad).toBe(0);
    // Past the 1,850 km slant range to an edge.
    expect(shape.radiusMeters).toBeGreaterThan(1_850_000);
    expect(shape.radiusMeters).toBeLessThan(2_500_000);
  });

  test("tilts toward the wider side of a sensor whose sides differ", () => {
    const shape = fanShape({ starboardKm: 1000, portKm: 500 }, above)!;
    expect(shape.rollRad).toBeGreaterThan(0);
    expect(shape.xHalfAngleRad + shape.rollRad).toBeCloseTo(nadirAngle(1_000_000, 830_000, 6_378_137), 3);
  });

  test("looks straight down and spreads across the track, starboard to the right of it", () => {
    const orientation = fanOrientation(above, north, 0)!;
    // Flying north over the equator at 0°: down is -x, starboard is east, +y.
    expect(axis(orientation, 2).x).toBeCloseTo(-1, 6);
    expect(axis(orientation, 1).y).toBeCloseTo(1, 6);
    const tilted = fanOrientation(above, north, CesiumMath.toRadians(10))!;
    expect(CesiumMath.toDegrees(Math.asin(axis(tilted, 2).y))).toBeCloseTo(10, 6);
  });

  test("lies in a plane through the satellite whose normal points ahead along the track", () => {
    const plane = scanPlane(above, north)!;
    expect(plane.point).toEqual(above);
    // North, flying north over the equator.
    expect(plane.ahead.z).toBeCloseTo(1, 6);
    expect(scanPlane(undefined, north)).toBeUndefined();
  });

  test("declines without a position or a direction", () => {
    expect(fanShape(VIIRS, undefined)).toBeUndefined();
    expect(fanOrientation(undefined, north, 0)).toBeUndefined();
    expect(fanOrientation(above, above, 0)).toBeUndefined();
  });
});

describe("modelUrl", () => {
  test("serves a manifest's file from data/models, subfolders included", () => {
    expect(modelUrl("ISS-(ZARYA).glb")).toBe("./data/models/ISS-(ZARYA).glb");
    expect(modelUrl("generic/CUBESAT-1U.glb")).toBe("./data/models/generic/CUBESAT-1U.glb");
  });
});

describe("orbitUsesPathGraphic", () => {
  test("tracked satellites always use the path graphic", () => {
    expect(orbitUsesPathGraphic(true, true)).toBe(true);
    expect(orbitUsesPathGraphic(true, false)).toBe(true);
  });

  test("untracked satellites use the primitive only when the scene supports it", () => {
    expect(orbitUsesPathGraphic(false, true)).toBe(false);
    expect(orbitUsesPathGraphic(false, false)).toBe(true);
  });
});

describe("geometryRefreshSeconds", () => {
  test("a handful of tracks refresh at the floor, where the lag would be visible", () => {
    expect(geometryRefreshSeconds(0)).toBe(GEOMETRY_REFRESH_MIN_SECONDS);
    expect(geometryRefreshSeconds(8)).toBe(GEOMETRY_REFRESH_MIN_SECONDS);
    expect(geometryRefreshSeconds(100)).toBe(GEOMETRY_REFRESH_MIN_SECONDS);
  });

  test("scales with the count between the bounds", () => {
    expect(geometryRefreshSeconds(500)).toBe(5);
  });

  test("clamps at the ceiling, where a rebuild costs more than the lag", () => {
    expect(geometryRefreshSeconds(1000)).toBe(GEOMETRY_REFRESH_MAX_SECONDS);
    expect(geometryRefreshSeconds(5000)).toBe(GEOMETRY_REFRESH_MAX_SECONDS);
  });
});

describe("cesiumSceneMode", () => {
  test("maps the three projections and refuses the one that is not", () => {
    expect(cesiumSceneMode("3D")).toBe(SceneMode.SCENE3D);
    expect(cesiumSceneMode("2D")).toBe(SceneMode.SCENE2D);
    expect(cesiumSceneMode("Columbus")).toBe(SceneMode.COLUMBUS_VIEW);
    // SkyView morphs for Sky itself.
    expect(cesiumSceneMode("Sky")).toBeUndefined();
    expect(cesiumSceneMode("nonsense")).toBeUndefined();
  });

  test("every projection name in the app's vocabulary maps", () => {
    // A mode added to SCENE_MODES without a projection would silently stop morphing.
    const unmapped = SCENE_MODES.filter((mode) => mode !== SKY_MODE && cesiumSceneMode(mode) === undefined);
    expect(unmapped).toEqual([]);
  });
});
