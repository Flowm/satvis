import { describe, expect, test } from "vitest";

import { ANTARCTIC, ARCTIC, toPolar } from "./polarStereographic";

describe("toPolar", () => {
  // PROJ 9's cs2cs, EPSG:4326 to EPSG:3995 and EPSG:3976.
  test.each([
    [ARCTIC, 70, 0, 0, -2194494.248],
    [ARCTIC, 60, 45, 2356881.674, -2356881.674],
    [ARCTIC, 85, -120, -470765.605, 271796.649],
    [ANTARCTIC, -70, 90, 2187927.649, 0],
    [ANTARCTIC, -80, 180, 0, -1085920.297],
    [ANTARCTIC, -85, -120, -469356.931, -270983.35],
  ])("projects as PROJ does: %#", (projection, latitude, longitude, x, y) => {
    const at = toPolar(projection, { latitude, longitude });
    expect(at.x).toBeCloseTo(x, 2);
    expect(at.y).toBeCloseTo(y, 2);
  });
});
