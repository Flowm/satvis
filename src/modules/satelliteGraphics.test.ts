import { Cartesian3, HeadingPitchRoll, Quaternion, SceneMode, Transforms } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { SCENE_MODES, SKY_MODE } from "../config/viewModes";
import {
  cesiumSceneMode,
  coneDescription,
  coneOrientation,
  groundTrackDescription,
  isLeo,
  modelUrl,
  orbitPathTimes,
  orbitTrackTimes,
  orbitUsesPathGraphic,
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

describe("groundTrackDescription", () => {
  test("converts the swath width to meters", () => {
    expect(groundTrackDescription("LEO", 290)).toEqual({ widthMeters: 290000 });
  });

  test("is unavailable for non-LEO satellites", () => {
    expect(groundTrackDescription("GEO", 290)).toBeUndefined();
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
    expect(() => Transforms.headingPitchRollQuaternion(undefined as any, new HeadingPitchRoll(0, Math.PI, 0))).toThrow(/origin is required/);
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
