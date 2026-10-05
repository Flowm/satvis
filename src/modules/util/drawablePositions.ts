// Cesium's geometry constructors drop consecutive duplicates (`arrayRemoveDuplicates`)
// and return `undefined` below two positions, but the instance stays in the batch:
// `recomputeBoundingSpheres` then dereferences the missing bounding sphere inside
// `Scene.render`, which stops the render loop for the session. So callers check
// `drawablePositions(...).length < 2`, not the raw count.

import { Cartesian3, Math as CesiumMath } from "@cesium/engine";

/**
 * Matches `arrayRemoveDuplicates`: consecutive-only, with the relative `EPSILON10`
 * (about a millimetre at Earth radius). Corridors dedupe after projecting onto the
 * ellipsoid, which only purely radial motion would trip.
 */
export function drawablePositions(positions: readonly (Cartesian3 | undefined)[]): Cartesian3[] {
  const drawable: Cartesian3[] = [];
  for (const position of positions) {
    // A hole outside the sampled window: an `undefined` position throws in Cesium's geometry worker.
    if (!position) {
      continue;
    }
    const previous = drawable[drawable.length - 1];
    if (previous && Cartesian3.equalsEpsilon(previous, position, CesiumMath.EPSILON10)) {
      continue;
    }
    drawable.push(position);
  }
  return drawable;
}
