// Which of a model's files is drawn at a size (ADR 0007), shared by the web app and,
// held to it, the native app. Cesium-free: node-env vitest exercises it.

import type { ModelLod } from "./satelliteMetadata";

/**
 * A model drawn by a copy goes back to a coarser copy only below this share of that
 * copy's maxPoints, so a model at the boundary does not flicker between them.
 */
export const MODEL_LEVEL_HYSTERESIS = 0.8;

/**
 * The level to draw a model at, 0 for its file and `i + 1` for `lods[i]`, from the
 * on-screen diameter of the level drawn now, `current`. A copy holds the model up to its
 * maxPoints; a coarser one takes over below MODEL_LEVEL_HYSTERESIS of its own.
 */
export function modelLevel(diameter: number, current: number, lods: readonly ModelLod[]): number {
  let level = Math.min(Math.max(current, 0), lods.length);
  while (level > 0 && diameter > lods[level - 1]!.maxPoints) {
    level -= 1;
  }
  while (level < lods.length && diameter < MODEL_LEVEL_HYSTERESIS * lods[level]!.maxPoints) {
    level += 1;
  }
  return level;
}
