import { Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath } from "@cesium/core";
import { describe, expect, test } from "vitest";

import { groundTrackRibbon, RIBBON_EDGE_METERS, RIBBON_HEIGHT_METERS, TRACK_SECONDS_ATTRIBUTE } from "./groundTrackRibbon";

/** A satellite flying north along the prime meridian at 400 km, a sample every 60 s. */
function northbound(samples: number): { seconds: number[]; positions: Cartesian3[] } {
  const seconds = Array.from({ length: samples }, (_, index) => index * 60);
  // About 3.8° of latitude a minute, 420 km on the ground.
  const positions = seconds.map((second) => Cartesian3.fromDegrees(0, second / 16, 400_000));
  return { seconds, positions };
}

function vertices(geometry: NonNullable<ReturnType<typeof groundTrackRibbon>>): { points: Cartographic[]; seconds: Float32Array } {
  const values = geometry.attributes.position!.values as Float64Array;
  const points: Cartographic[] = [];
  for (let at = 0; at < values.length; at += 3) {
    points.push(Cartographic.fromCartesian(new Cartesian3(values[at], values[at + 1], values[at + 2])));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { points, seconds: (geometry.attributes as any)[TRACK_SECONDS_ATTRIBUTE].values };
}

describe("groundTrackRibbon", () => {
  test("is undefined below two distinct sub-satellite points", () => {
    const here = Cartesian3.fromDegrees(0, 0, 400_000);
    expect(groundTrackRibbon([0], [here], { starboardMeters: 100_000, portMeters: 100_000 })).toBeUndefined();
    expect(groundTrackRibbon([0, 60], [here, Cartesian3.clone(here)], { starboardMeters: 100_000, portMeters: 100_000 })).toBeUndefined();
  });

  test("stamps every vertex with its time, interpolated where the samples are split", () => {
    const { seconds, positions } = northbound(3);
    const ribbon = vertices(groundTrackRibbon(seconds, positions, { starboardMeters: 50_000, portMeters: 50_000 })!);
    // 420 km between samples: three rows each, two vertices across.
    expect(Array.from(ribbon.seconds)).toEqual([0, 0, 20, 20, 40, 40, 60, 60, 80, 80, 100, 100, 120, 120]);
  });

  test("lies on the ground, starboard to the east of a northbound track", () => {
    const { seconds, positions } = northbound(2);
    const { points } = vertices(groundTrackRibbon(seconds, positions, { starboardMeters: 150_000, portMeters: 50_000 })!);
    for (const point of points) {
      expect(point.height).toBeCloseTo(RIBBON_HEIGHT_METERS, -1);
    }
    // The first row runs from port (west) to starboard (east).
    const metresPerDegree = (Ellipsoid.WGS84.maximumRadius * Math.PI) / 180;
    expect(CesiumMath.toDegrees(points[0]!.longitude) * metresPerDegree).toBeCloseTo(-50_000, -3);
    expect(CesiumMath.toDegrees(points[1]!.longitude) * metresPerDegree).toBeCloseTo(150_000, -3);
  });

  test("splits a wide swath so no edge across it is longer than the limit", () => {
    const { seconds, positions } = northbound(2);
    const geometry = groundTrackRibbon(seconds, positions, { starboardMeters: 700_000, portMeters: 700_000 })!;
    const values = geometry.attributes.position!.values as Float64Array;
    const across = Math.ceil(1_400_000 / RIBBON_EDGE_METERS) + 1;
    expect(values.length / 3).toBe(across * 4);
    const first = Cartesian3.unpack(values as unknown as number[], 0);
    const second = Cartesian3.unpack(values as unknown as number[], 3);
    // The limit holds on the ground; 3 km up the same angle spans 0.05% more.
    expect(Cartesian3.distance(first, second)).toBeLessThanOrEqual(RIBBON_EDGE_METERS * 1.001);
  });
});
