import { describe, expect, test } from "vitest";

import { defaultViewDistance } from "./defaultView";

const RADIUS = 6378137;
const FOV = Math.PI / 3;

describe("defaultViewDistance", () => {
  test("puts a desktop window 22,199 km from the Earth's centre", () => {
    expect(defaultViewDistance(FOV, 1400 / 900, RADIUS) / 1000).toBeCloseTo(22199, 0);
  });

  test("stands further back on a phone, whose narrow axis is the width", () => {
    expect(defaultViewDistance(FOV, 390 / 844, RADIUS)).toBeGreaterThan(defaultViewDistance(FOV, 1400 / 900, RADIUS));
  });
});
