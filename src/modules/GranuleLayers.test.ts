import { Math as CesiumMath } from "@cesium/core";
import { describe, expect, test } from "vitest";

import { layerRectangle } from "./GranuleLayers";

/** A closed ring through `corners`, as CMR lists one. */
function granule(corners: [latitude: number, longitude: number][]) {
  const outline = [...corners, corners[0]!].map(([latitude, longitude]) => ({ latitude, longitude }));
  return { start: 0, end: 0, day: true, outline };
}

const degrees = (radians: number) => CesiumMath.toDegrees(radians);

describe("layerRectangle", () => {
  test("boxes a granule's corners with a margin", () => {
    const box = layerRectangle(
      granule([
        [40, 10],
        [40, 20],
        [35, 20],
        [35, 10],
      ]),
    )!;
    expect(degrees(box.west)).toBeCloseTo(9, 6);
    expect(degrees(box.east)).toBeCloseTo(21, 6);
    expect(degrees(box.south)).toBeCloseTo(34, 6);
    // The northern edge, a great circle between two corners at 40°, bows past them.
    expect(degrees(box.north)).toBeGreaterThan(41.1);
  });

  test("takes in an edge bowing toward the pole between its corners", () => {
    // A 2,800 km edge at 70°: its middle runs 4.3° north of its ends.
    const box = layerRectangle(
      granule([
        [70, 0],
        [70, 79],
        [65, 79],
        [65, 0],
      ]),
    )!;
    expect(degrees(box.north)).toBeGreaterThan(74.3);
  });

  test("covers the globe for a granule across the antimeridian or near a pole", () => {
    expect(
      layerRectangle(
        granule([
          [10, 170],
          [10, -170],
          [0, -170],
          [0, 170],
        ]),
      ),
    ).toBeUndefined();
    expect(
      layerRectangle(
        granule([
          [79, 0],
          [79, 90],
          [75, 90],
          [75, 0],
        ]),
      ),
    ).toBeUndefined();
  });
});
