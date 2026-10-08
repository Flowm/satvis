/**
 * Progress in [0, 1] to eased progress: zero rate and acceleration at both ends, and
 * a peak rate 1.9 times the mean. Cesium's QUINTIC_IN_OUT peaks at 5 times, a whip
 * after a long standstill, and its CUBIC_OUT, the default for a descending flight,
 * starts at full speed.
 */
export const smootherstep = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
