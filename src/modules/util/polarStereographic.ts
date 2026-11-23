// The polar stereographic projections EUMETView's WMS draws a pole's pictures in: a granule
// over a pole, which plate carrée would stretch round the whole globe, is asked for in one of
// these and sampled by them (Snyder, Map Projections: A Working Manual, 21-33 to 21-38).
//
// Cesium-free, so node-env vitest reads it.

import type { GroundPoint } from "./cmrGranules";

/** A polar stereographic projection on WGS84, its latitude of true scale in degrees, its central meridian 0°. */
export interface PolarProjection {
  /** Its EPSG code, as a WMS names it. */
  srs: "EPSG:3995" | "EPSG:3976";
  /** 1 for the north pole, -1 for the south. */
  pole: 1 | -1;
  /** Degrees, where a metre of the map is a metre of the ground. */
  trueScaleLatitude: number;
}

/** Arctic Polar Stereographic. */
export const ARCTIC: PolarProjection = { srs: "EPSG:3995", pole: 1, trueScaleLatitude: 71 };

/** NSIDC Sea Ice Polar Stereographic South. */
export const ANTARCTIC: PolarProjection = { srs: "EPSG:3976", pole: -1, trueScaleLatitude: -70 };

/** WGS84's semi-major axis, metres. */
const WGS84_A = 6378137;

/** WGS84's first eccentricity. */
export const WGS84_E = Math.sqrt(0.00669437999014);

/** Radians a degree. */
const RADIANS = Math.PI / 180;

/** Snyder's t of a latitude in radians, on the pole's own side. */
function t(latitude: number): number {
  const sine = WGS84_E * Math.sin(latitude);
  return Math.tan(Math.PI / 4 - latitude / 2) / ((1 - sine) / (1 + sine)) ** (WGS84_E / 2);
}

/** Metres from the pole a unit of `t` is: a times Snyder's m over t at the latitude of true scale. */
export function radiusScale(projection: PolarProjection): number {
  const latitude = projection.pole * projection.trueScaleLatitude * RADIANS;
  const sine = Math.sin(latitude);
  return (WGS84_A * Math.cos(latitude)) / Math.sqrt(1 - WGS84_E * WGS84_E * sine * sine) / t(latitude);
}

/** Where `point` lies in `projection`, metres east and north of the pole. */
export function toPolar(projection: PolarProjection, point: GroundPoint): { x: number; y: number } {
  const radius = radiusScale(projection) * t(projection.pole * point.latitude * RADIANS);
  const longitude = point.longitude * RADIANS;
  return { x: radius * Math.sin(longitude), y: -projection.pole * radius * Math.cos(longitude) };
}
