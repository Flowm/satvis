/**
 * How much of the screen's narrower axis the globe spans on opening. Under one so
 * the whole disc is in frame with room around it, rather than touching two edges.
 */
const DEFAULT_VIEW_FILL = 0.82;

/**
 * How far the default view's camera is from the centre of a globe of `radius`.
 *
 * Cesium's `fov` is the horizontal angle on a landscape viewport and the vertical
 * one otherwise, so the derived angle is always the narrow one, which the globe
 * has to fit inside.
 */
export function defaultViewDistance(fov: number, aspectRatio: number, radius: number): number {
  const narrow = aspectRatio > 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspectRatio) : 2 * Math.atan(Math.tan(fov / 2) * aspectRatio);
  return radius / Math.sin((narrow / 2) * DEFAULT_VIEW_FILL);
}
