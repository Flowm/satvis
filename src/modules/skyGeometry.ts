// The angles the sky view is built on, and the east-north-up vectors they name.
// SkyView, DeviceAim and SkyTargets must agree exactly, so there is one copy:
// composing and decomposing a basis must be each other's inverse.

import { Cartesian3, Cartographic, Math as CesiumMath, Matrix3, Matrix4, Transforms } from "@cesium/engine";

/** See observer in CONTEXT.md. */
export interface Observer {
  lat: number;
  lon: number;
}

/**
 * In degrees: azimuth clockwise from north, pitch above the horizontal, roll about
 * the view axis (from a handheld device). Pitch, not elevation: "elevation" is a
 * satellite's position in the sky (see pass in CONTEXT.md).
 */
export interface Aim {
  azimuth: number;
  pitch: number;
  roll: number;
}

/** Owned by `SkyView`, which knows when the observer moves. */
export interface ObserverFrame {
  position: Cartesian3;
  fixedToEnu: Matrix3;
}

export function observerFrame(position: Cartesian3): ObserverFrame {
  const enuToFixed = Matrix4.getMatrix3(Transforms.eastNorthUpToFixedFrame(position, undefined, new Matrix4()), new Matrix3());
  return {
    position: Cartesian3.clone(position, new Cartesian3()),
    // Orthonormal, so the transpose is the inverse.
    fixedToEnu: Matrix3.transpose(enuToFixed, new Matrix3()),
  };
}

/**
 * Offsets in metres, applied in the tangent plane at the observer: no antimeridian
 * wrap and no stretch near the poles. The error is the sagitta d²/2R, 8 cm at 1 km.
 */
export function offsetObserver(observer: Observer, east: number, north: number): Observer {
  const origin = Cartesian3.fromDegrees(observer.lon, observer.lat);
  const enuToFixed = Transforms.eastNorthUpToFixedFrame(origin, undefined, new Matrix4());
  const moved = Matrix4.multiplyByPoint(enuToFixed, new Cartesian3(east, north, 0), new Cartesian3());
  const carto = Cartographic.fromCartesian(moved);
  // Only the Earth's centre has no coordinates, which no surface offset reaches.
  return carto ? { lat: CesiumMath.toDegrees(carto.latitude), lon: CesiumMath.toDegrees(carto.longitude) } : observer;
}

/** To [0, 360). */
export const normalizeAzimuth = (degrees: number): number => ((degrees % 360) + 360) % 360;

/** In east-north-up, of length `distance`. */
export function enuDirection(azimuth: number, elevation: number, distance = 1): Cartesian3 {
  const az = CesiumMath.toRadians(azimuth);
  const el = CesiumMath.toRadians(elevation);
  const cosEl = Math.cos(el);
  return new Cartesian3(Math.sin(az) * cosEl * distance, Math.cos(az) * cosEl * distance, Math.sin(el) * distance);
}

/**
 * In east-north-up. Neither vector is a cross product with world up, so both stay
 * defined at the zenith.
 */
export function levelBasis(azimuth: number, elevation: number): { up: Cartesian3; right: Cartesian3 } {
  const az = CesiumMath.toRadians(azimuth);
  const el = CesiumMath.toRadians(elevation);
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);
  const sinEl = Math.sin(el);
  return {
    up: new Cartesian3(-sinAz * sinEl, -cosAz * sinEl, Math.cos(el)),
    right: new Cartesian3(cosAz, -sinAz, 0),
  };
}

/** The inverse of `rollOf`; opposite signs between the two mirror the view. */
export function rollBasis(azimuth: number, elevation: number, roll: number): { up: Cartesian3; right: Cartesian3 } {
  const { up: levelUp, right: levelRight } = levelBasis(azimuth, elevation);
  const radians = CesiumMath.toRadians(roll);
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  return {
    up: new Cartesian3(levelUp.x * cos - levelRight.x * sin, levelUp.y * cos - levelRight.y * sin, levelUp.z * cos - levelRight.z * sin),
    right: new Cartesian3(levelRight.x * cos + levelUp.x * sin, levelRight.y * cos + levelUp.y * sin, levelRight.z * cos + levelUp.z * sin),
  };
}

/** The inverse of `rollBasis`. */
export function rollOf(azimuth: number, elevation: number, up: Cartesian3): number {
  const { up: levelUp, right: levelRight } = levelBasis(azimuth, elevation);
  return CesiumMath.toDegrees(Math.atan2(-Cartesian3.dot(up, levelRight), Cartesian3.dot(up, levelUp)));
}
