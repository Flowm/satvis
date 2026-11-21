import { Cartesian3, Ellipsoid, FixedFrameTransforms, HeadingPitchRoll, Math as CesiumMath, Matrix3, Quaternion } from "@cesium/core";
import { SceneMode } from "@cesium/engine";

import type { OrbitClass } from "@/config/orbitClass";
import type { SwathExtents } from "@/config/satelliteMetadata";
import type { RibbonSwath } from "@/modules/util/groundTrackRibbon";

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

/** Each side's extent in metres; undefined off LEO. */
export function groundTrackSwath(orbitClass: OrbitClass, swath: SwathExtents): RibbonSwath | undefined {
  if (!isLeo(orbitClass)) {
    return undefined;
  }
  return { starboardMeters: swath.starboardKm * 1000, portMeters: swath.portKm * 1000 };
}

export interface ConeDescription {
  radiusMeters: number;
  innerHalfAngleRad: number;
  outerHalfAngleRad: number;
}

/** Metres from the satellite to the end of its sensor cone: all of it lies within this of the satellite. */
export const CONE_RADIUS_METERS = 1_000_000;

export function coneDescription(orbitClass: OrbitClass, fovDeg: number): ConeDescription | undefined {
  if (!isLeo(orbitClass)) {
    return undefined;
  }
  return {
    radiusMeters: CONE_RADIUS_METERS,
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
  return FixedFrameTransforms.headingPitchRollQuaternion(position, CONE_HEADING_PITCH_ROLL);
}

/**
 * Radians off nadir at which a sensor `altitudeMeters` over a sphere of `earthRadiusMeters`
 * sees the ground `groundMeters` away along it.
 */
export function nadirAngle(groundMeters: number, altitudeMeters: number, earthRadiusMeters: number): number {
  const central = groundMeters / earthRadiusMeters;
  return Math.atan2(earthRadiusMeters * Math.sin(central), earthRadiusMeters + altitudeMeters - earthRadiusMeters * Math.cos(central));
}

/** A swath fan at one moment: a rectangular sensor, tilted toward starboard by `rollRad`. */
export interface FanShape {
  /** Half the angle across the track, from port edge to starboard edge. */
  xHalfAngleRad: number;
  /** Toward starboard from nadir: a sensor whose sides differ is tilted. */
  rollRad: number;
  /** Metres, past the farther edge's slant range, so the fan reaches the ground on both sides. */
  radiusMeters: number;
}

/** How far past the slant range to the farther edge the fan's sides reach, which the globe hides. */
const FAN_REACH = 1.2;

/** Radians: half the fan's width along the track, enough to see it edge-on. */
export const FAN_ALONG_HALF_ANGLE = CesiumMath.toRadians(0.3);

/** Radians a fan's angles are rounded to, so a satellite's slowly changing height rebuilds it now and then, not every frame. */
const FAN_ANGLE_STEP = CesiumMath.toRadians(0.02);

const scratchSubpoint = new Cartesian3();

/**
 * The fan from a satellite at `position` to its swath's edges, the ground track's ribbon's
 * at the satellite; undefined without a position.
 */
export function fanShape(swath: SwathExtents, position: Cartesian3 | undefined): FanShape | undefined {
  const subpoint = position && Ellipsoid.WGS84.scaleToGeodeticSurface(position, scratchSubpoint);
  if (!position || !subpoint) {
    return undefined;
  }
  const earthRadius = Cartesian3.magnitude(subpoint);
  const altitude = Cartesian3.magnitude(position) - earthRadius;
  const starboard = nadirAngle(swath.starboardKm * 1000, altitude, earthRadius);
  const port = nadirAngle(swath.portKm * 1000, altitude, earthRadius);
  const round = (angle: number) => Math.round(angle / FAN_ANGLE_STEP) * FAN_ANGLE_STEP;
  // Law of cosines, from the satellite to the farther edge.
  const central = Math.max(swath.starboardKm, swath.portKm) / (earthRadius / 1000);
  const orbitRadius = earthRadius + altitude;
  const slant = Math.sqrt(earthRadius ** 2 + orbitRadius ** 2 - 2 * earthRadius * orbitRadius * Math.cos(central));
  return { xHalfAngleRad: round((starboard + port) / 2), rollRad: round((starboard - port) / 2), radiusMeters: Math.round((slant * FAN_REACH) / 1000) * 1000 };
}

const scratchNextSubpoint = new Cartesian3();
const scratchUp = new Cartesian3();
const scratchDown = new Cartesian3();
const scratchStarboard = new Cartesian3();
const scratchX = new Cartesian3();
const scratchY = new Cartesian3();
const scratchZ = new Cartesian3();
const scratchMatrix = new Matrix3();

/**
 * The fan's frame in Earth-fixed axes: its sensor looks along z, from the satellite to its
 * ground point tilted `rollRad` toward starboard, and spreads along y, across the track as
 * the ribbon's starboard is: cesium-sensor-volumes spreads a rectangular sensor's
 * `xHalfAngle` along its y axis. x is then ahead along the track. `next` is the satellite a
 * moment later, for the ground track's direction. Undefined where either position is, or
 * where the two share a ground point.
 */
export function fanOrientation(position: Cartesian3 | undefined, next: Cartesian3 | undefined, rollRad: number, result = new Quaternion()): Quaternion | undefined {
  const frame = fanFrame(position, next, rollRad);
  return frame && Quaternion.fromRotationMatrix(frame, result);
}

/** The plane the swath fan lies in: through the satellite, `ahead` its unit normal along the track. */
export interface ScanPlane {
  point: Cartesian3;
  ahead: Cartesian3;
}

/** The swath fan's plane, which a granule is sensed behind (ADR 0023); undefined as `fanOrientation` is. */
export function scanPlane(position: Cartesian3 | undefined, next: Cartesian3 | undefined): ScanPlane | undefined {
  const frame = fanFrame(position, next, 0);
  return frame && { point: Cartesian3.clone(position!), ahead: Matrix3.getColumn(frame, 0, new Cartesian3()) };
}

function fanFrame(position: Cartesian3 | undefined, next: Cartesian3 | undefined, rollRad: number): Matrix3 | undefined {
  const ellipsoid = Ellipsoid.WGS84;
  const here = position && ellipsoid.scaleToGeodeticSurface(position, scratchSubpoint);
  const there = next && ellipsoid.scaleToGeodeticSurface(next, scratchNextSubpoint);
  if (!position || !here || !there) {
    return undefined;
  }
  const tangent = Cartesian3.subtract(there, here, scratchY);
  if (Cartesian3.magnitudeSquared(tangent) < 1) {
    return undefined;
  }
  ellipsoid.geodeticSurfaceNormal(here, scratchUp);
  // As the ribbon finds its starboard (groundTrackRibbon), then level under the satellite.
  Cartesian3.cross(tangent, scratchUp, scratchStarboard);
  const down = Cartesian3.normalize(Cartesian3.subtract(here, position, scratchDown), scratchDown);
  Cartesian3.subtract(scratchStarboard, Cartesian3.multiplyByScalar(down, Cartesian3.dot(scratchStarboard, down), scratchZ), scratchStarboard);
  Cartesian3.normalize(scratchStarboard, scratchStarboard);
  const cos = Math.cos(rollRad);
  const sin = Math.sin(rollRad);
  const z = Cartesian3.add(Cartesian3.multiplyByScalar(down, cos, scratchZ), Cartesian3.multiplyByScalar(scratchStarboard, sin, scratchX), scratchZ);
  const y = Cartesian3.subtract(Cartesian3.multiplyByScalar(scratchStarboard, cos, scratchX), Cartesian3.multiplyByScalar(down, sin, scratchY), scratchY);
  const x = Cartesian3.cross(y, z, scratchX);
  const m = scratchMatrix;
  Matrix3.setColumn(m, 0, x, m);
  Matrix3.setColumn(m, 1, y, m);
  Matrix3.setColumn(m, 2, z, m);
  return m;
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
 * Re-cut interval for the batched orbit tracks. The satellite runs ahead of its
 * geometry at about 7.5 km/s in LEO until the next re-cut. At 5,000 orbit tracks,
 * 3 s instead of 10 s took the worst frame from 43 ms to 250 ms.
 */
export function geometryRefreshSeconds(count: number): number {
  return Math.min(GEOMETRY_REFRESH_MAX_SECONDS, Math.max(GEOMETRY_REFRESH_MIN_SECONDS, count / 100));
}
