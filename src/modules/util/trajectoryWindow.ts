// The extent of a satellite's sampled-position window. SampledTrajectory fills it
// and SatelliteManager prefetches it, so both take the bounds from here.

/** Trades accuracy against propagation time and sample memory (see SampledTrajectory). */
export const SAMPLES_PER_ORBIT = 120;

/** Kept behind the satellite, in revolutions. */
export const WINDOW_ORBITS_BACK = 0.5;

/** Kept ahead, in revolutions. The Orbit component needs a full one. */
export const WINDOW_ORBITS_FORWARD = 1.5;

export interface TrajectoryWindow {
  /** Seconds from the reference time to the first sample. Negative. */
  offsetSeconds: number;
  stepSeconds: number;
  /** First and last inclusive. */
  sampleCount: number;
  spanSeconds: number;
}

/**
 * `sampleCount` includes the closing boundary: 241, not 240, for two orbits at 120
 * samples an orbit.
 */
export function trajectoryWindow(orbitalPeriodMinutes: number): TrajectoryWindow {
  // A satrec that failed to parse has no mean motion, so the period is zero or
  // infinite. An empty window keeps NaN out of the worker's buffer sizes.
  if (!Number.isFinite(orbitalPeriodMinutes) || orbitalPeriodMinutes <= 0) {
    return { offsetSeconds: 0, stepSeconds: 0, sampleCount: 0, spanSeconds: 0 };
  }
  const orbitalPeriodSeconds = orbitalPeriodMinutes * 60;
  const stepSeconds = orbitalPeriodSeconds / SAMPLES_PER_ORBIT;
  const spanSeconds = orbitalPeriodSeconds * (WINDOW_ORBITS_BACK + WINDOW_ORBITS_FORWARD);
  return {
    offsetSeconds: -orbitalPeriodSeconds * WINDOW_ORBITS_BACK,
    stepSeconds,
    sampleCount: Math.floor(spanSeconds / stepSeconds) + 1,
    spanSeconds,
  };
}
