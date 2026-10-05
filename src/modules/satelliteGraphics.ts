import { HeadingPitchRoll, Math as CesiumMath, SceneMode, Transforms } from "@cesium/engine";
import type { Cartesian3, Quaternion } from "@cesium/engine";

import type { OrbitClass } from "../config/orbitClass";

// Pure geometry decisions for the satellite components, testable without a Cesium scene.

/**
 * Ground track and sensor cone are only rendered for LEO. Use the orbit class the
 * info panel shows, not a period threshold, so the two cannot disagree.
 */
export function isLeo(orbitClass: OrbitClass): boolean {
  return orbitClass === "LEO";
}

export interface OrbitPathTimes {
  leadTime: number;
  trailTime: number;
}

/** Lead/trail half a period (+5 s overlap) so the path closes into a full orbit. */
export function orbitPathTimes(orbitalPeriodMin: number): OrbitPathTimes {
  const halfPeriod = (orbitalPeriodMin * 60) / 2 + 5;
  return { leadTime: halfPeriod, trailTime: halfPeriod };
}

/** One full period ahead, nothing behind. */
export function orbitTrackTimes(orbitalPeriodMin: number): OrbitPathTimes {
  return { leadTime: orbitalPeriodMin * 60, trailTime: 0 };
}

export interface GroundTrackDescription {
  widthMeters: number;
}

export function groundTrackDescription(orbitClass: OrbitClass, swathKm: number): GroundTrackDescription | undefined {
  if (!isLeo(orbitClass)) {
    return undefined;
  }
  return { widthMeters: swathKm * 1000 };
}

export interface ConeDescription {
  radiusMeters: number;
  innerHalfAngleRad: number;
  outerHalfAngleRad: number;
}

export function coneDescription(orbitClass: OrbitClass, fovDeg: number): ConeDescription | undefined {
  if (!isLeo(orbitClass)) {
    return undefined;
  }
  return {
    radiusMeters: 1000000,
    innerHalfAngleRad: CesiumMath.toRadians(0),
    outerHalfAngleRad: CesiumMath.toRadians(fovDeg),
  };
}

/** Straight down. Hoisted because the callback runs per satellite per frame. */
const CONE_HEADING_PITCH_ROLL = new HeadingPitchRoll(0, CesiumMath.toRadians(180), 0);

/**
 * Undefined when the position is: `headingPitchRollQuaternion` throws on an
 * undefined origin inside Cesium's render loop, which then stops for the session.
 */
export function coneOrientation(position: Cartesian3 | undefined): Quaternion | undefined {
  if (!position) {
    return undefined;
  }
  return Transforms.headingPitchRollQuaternion(position, CONE_HEADING_PITCH_ROLL);
}

/** Where a model manifest's file is served, relative to the page. */
export function modelUrl(modelFile: string): string {
  return `./data/models/${modelFile}`;
}

/** The tracked satellite and scene modes without primitive model-matrix updates need a path graphic. */
export function orbitUsesPathGraphic(isTracked: boolean, sceneModeSupportsPrimitive: boolean): boolean {
  return isTracked || !sceneModeSupportsPrimitive;
}

/** Undefined for "Sky", which is a camera placement that SkyView morphs for itself. */
export function cesiumSceneMode(viewMode: string): SceneMode | undefined {
  switch (viewMode) {
    case "3D":
      return SceneMode.SCENE3D;
    case "2D":
      return SceneMode.SCENE2D;
    case "Columbus":
      return SceneMode.COLUMBUS_VIEW;
    default:
      return undefined;
  }
}

/** Bounds on how often time-dependent geometry is re-cut, in simulation seconds. */
export const GEOMETRY_REFRESH_MIN_SECONDS = 1;
export const GEOMETRY_REFRESH_MAX_SECONDS = 10;

/**
 * Re-cut interval for the batched orbit tracks and ground-track corridors. The
 * satellite runs ahead of its geometry at about 7.5 km/s in LEO until the next
 * re-cut. At 5,000 orbit tracks, 3 s instead of 10 s took the worst frame from
 * 43 ms to 250 ms.
 */
export function geometryRefreshSeconds(count: number): number {
  return Math.min(GEOMETRY_REFRESH_MAX_SECONDS, Math.max(GEOMETRY_REFRESH_MIN_SECONDS, count / 100));
}
