// The TEME to pseudo-fixed rotation, as arithmetic on epoch milliseconds: Cesium's
// `computeTemeToPseudoFixedMatrix` formula and constants (agreeing to 0.001 mm over
// three years), but Cesium-free, so it runs in the propagation worker. Transform cost
// for 5,000 satellites of 241 samples: Cesium 220 ms, Cesium with scratch objects
// 105 ms, this 31 ms.
//
// Not satellite.js's `gstime`, which differs by 1.5e-9 rad (1 cm at LEO, 6 cm at
// GEO): matching Cesium keeps the stored positions what Cesium's transform produced.

/** Cesium's GMST polynomial, in seconds, evaluated in Julian centuries from J2000. */
const GMST_C0 = 6 * 3600 + 41 * 60 + 50.54841;
const GMST_C1 = 8640184.812866;
const GMST_C2 = 0.093104;
const GMST_C3 = -6.2e-6;

/** Precession of the rotation rate, per day from J2000. */
const RATE_COEF = 1.1772758384668e-19;

const WGS84_WR_PRECESSING = 7.2921158553e-5;

const TWO_PI = Math.PI * 2;
const SECONDS_PER_DAY = 86400;
const TWO_PI_PER_SECONDS_PER_DAY = TWO_PI / SECONDS_PER_DAY;
const MS_PER_DAY = 86_400_000;
const J2000_DAY_NUMBER = 2451545;

/** J2000 proper is noon, so the rate term is referred to the midnight before it. */
const J2000_MIDNIGHT = J2000_DAY_NUMBER - 0.5;

/** A Julian day starts at noon, so the Unix epoch is half a day into this one. */
const UNIX_EPOCH_DAY_NUMBER = 2440587;
const HALF_DAY_SECONDS = 43200;

/**
 * Greenwich hour angle for a UTC instant, in radians. Cesium converts UTC to TAI and
 * back before this arithmetic, so starting from Unix time is equivalent except across
 * a leap second (see the test).
 */
export function greenwichHourAngle(epochMs: number): number {
  // Split off the day first: a whole Julian date in one double has an ulp of about
  // 47 us of Earth rotation, which measured as a 9.5 mm error.
  const days = Math.floor(epochMs / MS_PER_DAY);
  const msIntoDay = epochMs - days * MS_PER_DAY;
  let dayNumber = UNIX_EPOCH_DAY_NUMBER + days;
  let secondsOfDay = HALF_DAY_SECONDS + msIntoDay / 1000;
  if (secondsOfDay >= SECONDS_PER_DAY) {
    secondsOfDay -= SECONDS_PER_DAY;
    dayNumber += 1;
  }

  // GMST is tabulated at 0h, so the half-day offset picks the tabulation this
  // instant belongs to.
  const centuries = (dayNumber - J2000_DAY_NUMBER + (secondsOfDay >= HALF_DAY_SECONDS ? 0.5 : -0.5)) / 36525;
  const gmstSeconds = GMST_C0 + centuries * (GMST_C1 + centuries * (GMST_C2 + centuries * GMST_C3));
  const angleAt0h = (gmstSeconds * TWO_PI_PER_SECONDS_PER_DAY) % TWO_PI;
  const rotationRate = WGS84_WR_PRECESSING + RATE_COEF * (dayNumber - J2000_MIDNIGHT);
  const secondsSinceMidnight = (secondsOfDay + HALF_DAY_SECONDS) % SECONDS_PER_DAY;
  return angleAt0h + rotationRate * secondsSinceMidnight;
}

/** The fixed-frame position is `(c*x + s*y, -s*x + c*y, z)`. */
export interface FixedRotation {
  cos: number;
  sin: number;
}

export function fixedRotationAt(epochMs: number, result: FixedRotation): FixedRotation {
  const gha = greenwichHourAngle(epochMs);
  result.cos = Math.cos(gha);
  result.sin = Math.sin(gha);
  return result;
}
