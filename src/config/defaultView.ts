/** The share of the screen's narrower axis the globe spans on opening. */
const DEFAULT_VIEW_FILL = 0.82;

/**
 * The default view's distance from the centre of a globe of `radius`. Cesium's `fov`
 * is horizontal on a landscape viewport and vertical otherwise, so `narrow` is always
 * the angle the globe must fit inside.
 */
export function defaultViewDistance(fov: number, aspectRatio: number, radius: number): number {
  const narrow = aspectRatio > 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspectRatio) : 2 * Math.atan(Math.tan(fov / 2) * aspectRatio);
  return radius / Math.sin((narrow / 2) * DEFAULT_VIEW_FILL);
}
