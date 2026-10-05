import { Cartesian3, CorridorGeometry, Math as CesiumMath, PolylineGeometry } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { drawablePositions } from "./drawablePositions";

/** On the ellipsoid, so the relative epsilon works at the callers' magnitudes. */
const SURFACE = new Cartesian3(6378137, 0, 0);

describe("drawablePositions", () => {
  test("keeps distinct positions in order", () => {
    const a = new Cartesian3(1e6, 0, 0);
    const b = new Cartesian3(0, 1e6, 0);
    expect(drawablePositions([a, b])).toEqual([a, b]);
  });

  test("drops holes", () => {
    const a = new Cartesian3(1e6, 0, 0);
    const b = new Cartesian3(0, 1e6, 0);
    expect(drawablePositions([undefined, a, undefined, b, undefined])).toEqual([a, b]);
  });

  // Outside the sample window `GridPositionProperty` holds the edge sample, so two
  // times answer with one position. This stopped the render loop.
  test("a held position collapses to one, so callers can see it is not a track", () => {
    expect(drawablePositions([SURFACE, SURFACE])).toHaveLength(1);
    expect(drawablePositions([SURFACE, SURFACE, SURFACE])).toHaveLength(1);
  });

  test("nothing usable is nothing, not a degenerate pair", () => {
    expect(drawablePositions([])).toEqual([]);
    expect(drawablePositions([undefined, undefined])).toEqual([]);
  });

  // `wrapAround` false: an orbit that returns to its start is a closed track.
  test("only consecutive duplicates collapse", () => {
    const a = new Cartesian3(1e6, 0, 0);
    const b = new Cartesian3(0, 1e6, 0);
    expect(drawablePositions([a, b, a])).toEqual([a, b, a]);
  });

  test("the epsilon is Cesium's, so real motion survives", () => {
    const near = Cartesian3.add(SURFACE, new Cartesian3(SURFACE.x * CesiumMath.EPSILON10 * 0.5, 0, 0), new Cartesian3());
    expect(drawablePositions([SURFACE, near])).toHaveLength(1);

    const metre = Cartesian3.add(SURFACE, new Cartesian3(1, 0, 0), new Cartesian3());
    expect(drawablePositions([SURFACE, metre])).toHaveLength(2);
  });
});

// Pins the Cesium behaviour behind `length < 2`. If an upgrade changes it, revisit the guards.
describe("what Cesium does with the positions this module rejects", () => {
  const KM = 200000;
  const along = Cartesian3.add(SURFACE, new Cartesian3(0, KM, 0), new Cartesian3());

  test("a corridor from two of a point builds nothing", () => {
    const degenerate = CorridorGeometry.createGeometry(new CorridorGeometry({ positions: [SURFACE, SURFACE], width: 10000 }));
    expect(degenerate).toBeUndefined();

    const real = CorridorGeometry.createGeometry(new CorridorGeometry({ positions: [SURFACE, along], width: 10000 }));
    expect(real).toBeDefined();
  });

  test("a polyline from two of a point builds nothing", () => {
    const degenerate = PolylineGeometry.createGeometry(new PolylineGeometry({ positions: [SURFACE, SURFACE], width: 2 }));
    expect(degenerate).toBeUndefined();

    const real = PolylineGeometry.createGeometry(new PolylineGeometry({ positions: [SURFACE, along], width: 2 }));
    expect(real).toBeDefined();
  });
});
