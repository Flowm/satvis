import { Math as CesiumMath } from "@cesium/core";
import { describe, expect, test } from "vitest";

import { chaseOffset, chaseTilt } from "./ReplayCamera";

describe("chase", () => {
  test("keeps a narrow swath's satellite within 12° of the aim", () => {
    // Landsat 9: 185 km swath, 705 km up.
    expect(CesiumMath.toDegrees(chaseTilt(185, 705_000))).toBeCloseTo(12, 5);
  });

  test("keeps a wide swath's range", () => {
    // NOAA-20: 3,000 km swath, 824 km up, 12.1° before the floor on the range.
    expect(CesiumMath.toDegrees(chaseTilt(3000, 824_000))).toBeCloseTo(12, 0);
    // A higher orbit's satellite does not get closer than a lower one's.
    expect(CesiumMath.toDegrees(chaseTilt(185, 1_200_000))).toBeLessThanOrEqual(12 + 1e-9);
  });

  test("looks at the ground under the satellite from 50°", () => {
    const offset = chaseOffset(185, 705_000);
    expect(CesiumMath.toDegrees(Math.atan2(offset.z + 705_000, -offset.x))).toBeCloseTo(50, 5);
  });
});
