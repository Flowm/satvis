// Whether a granule was sensed by day, where its catalogue does not say: NOAA's Metop
// granules in CMR, and every one the Data Store lists.
//
// Cesium-free, so node-env vitest reads it.

import type { GroundPoint } from "./cmrGranules";

const RADIANS = Math.PI / 180;

/** Days since J2000.0 (2000-01-01T12:00Z). */
const J2000_MS = Date.UTC(2000, 0, 1, 12);

/**
 * The sun's elevation in degrees at `point` and `time` (epoch ms), by the Astronomical
 * Almanac's low-precision formulas: within 0.1° to 2050, ample for day or night.
 */
export function sunElevation(point: GroundPoint, time: number): number {
  const days = (time - J2000_MS) / 86_400_000;
  const anomaly = (357.529 + 0.98560028 * days) * RADIANS;
  const meanLongitude = 280.459 + 0.98564736 * days;
  const longitude = (meanLongitude + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * RADIANS;
  const obliquity = (23.439 - 0.00000036 * days) * RADIANS;
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(longitude), Math.cos(longitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(longitude));
  const siderealDegrees = 280.46061837 + 360.98564736629 * days;
  const hourAngle = (siderealDegrees + point.longitude) * RADIANS - rightAscension;
  const latitude = point.latitude * RADIANS;
  return Math.asin(Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle)) / RADIANS;
}

/** Whether the sun was up over any corner of `outline` midway through `start` to `end`: some of it sensed by day. */
export function sunlit(outline: readonly GroundPoint[], start: number, end: number): boolean {
  const time = (start + end) / 2;
  return outline.some((corner) => sunElevation(corner, time) > 0);
}
