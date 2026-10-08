// Whether a satellite could be seen by eye, from geometry alone: lit by the sun,
// against a dark enough sky. Brightness is not modelled, so a dark-coated Starlink in
// sunlight counts. Cesium-free, so the pass worker can use it too.

import { greenwichHourAngle } from "./temeToFixed";

/** Metres, in the pseudo-fixed frame the samples are kept in. */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/** See visibility in CONTEXT.md. */
export type Visibility = "visible" | "shadow" | "daylight" | "far";

/** What the sky view does with the satellites that are not visible: `?unseen=`. */
export const UNSEEN_MODES = ["show", "dim", "hide"] as const;
/** One of `UNSEEN_MODES`. */
export type UnseenMode = (typeof UNSEEN_MODES)[number];

/**
 * Degrees: the end of civil twilight, from which the ISS and other bright satellites
 * show. A stand-in until a faintest visible magnitude replaces it.
 */
export const DARK_SKY_SUN_ELEVATION = -6;

/**
 * Beyond this a satellite is too faint to see by eye: 5 magnitudes per tenfold range
 * take a bright one, magnitude 3 at 1,000 km, past the naked-eye limit of about 6 at
 * 4,000 km. Rules out GEO (magnitude 10-15), GNSS in MEO and HEO near apogee. A
 * stand-in until a predicted magnitude replaces it.
 */
export const MAX_VISIBLE_RANGE_KM = 5000;

/**
 * Metres. The shadow is a cylinder of the mean radius: the penumbra and the flattening
 * move shadow entry in LEO by a few seconds.
 */
const EARTH_RADIUS = 6_371_000;

// Julian dates, for the almanac's days since J2000.
const MS_PER_DAY = 86_400_000;
const UNIX_EPOCH_JULIAN_DATE = 2440587.5;
const J2000_JULIAN_DATE = 2451545;
const DEGREES = Math.PI / 180;

/**
 * A unit vector toward the sun in the pseudo-fixed frame, by the Astronomical Almanac's
 * low-precision formula (about 0.01° from 1950 to 2050), whose true-of-date frame is
 * TEME at that precision. The same as `Sun.swift` in the iOS app.
 */
export function sunDirection<T extends Vector3>(epochMs: number, result: T): T {
  const days = epochMs / MS_PER_DAY + UNIX_EPOCH_JULIAN_DATE - J2000_JULIAN_DATE;
  const meanLongitude = (280.46 + 0.9856474 * days) * DEGREES;
  const meanAnomaly = (357.528 + 0.9856003 * days) * DEGREES;
  const eclipticLongitude = meanLongitude + (1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEGREES;
  const obliquity = (23.439 - 0.0000004 * days) * DEGREES;
  const x = Math.cos(eclipticLongitude);
  const y = Math.cos(obliquity) * Math.sin(eclipticLongitude);
  const angle = greenwichHourAngle(epochMs);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  result.x = cos * x + sin * y;
  result.y = -sin * x + cos * y;
  result.z = Math.sin(obliquity) * Math.sin(eclipticLongitude);
  return result;
}

/** `sun` is a unit vector from `sunDirection`. */
export function inEarthShadow(position: Vector3, sun: Vector3): boolean {
  const along = position.x * sun.x + position.y * sun.y + position.z * sun.z;
  if (along >= 0) {
    return false;
  }
  const distanceSquared = position.x * position.x + position.y * position.y + position.z * position.z;
  return distanceSquared - along * along < EARTH_RADIUS * EARTH_RADIUS;
}

/**
 * A bright sky hides a satellite whether it is lit or not, so daylight comes first;
 * a far one stays unseen in sunlight, so distance comes before the shadow.
 */
export function visibility(sunElevation: number, sunlit: boolean, rangeKm: number): Visibility {
  if (sunElevation > DARK_SKY_SUN_ELEVATION) {
    return "daylight";
  }
  if (rangeKm > MAX_VISIBLE_RANGE_KM) {
    return "far";
  }
  return sunlit ? "visible" : "shadow";
}
