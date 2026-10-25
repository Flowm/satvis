import { describe, expect, it } from "vitest";

import { MODEL_LEVEL_HYSTERESIS, modelLevel } from "./modelLevels";

const ISS = [{ file: "ISS-(ZARYA)-low.glb", maxPoints: 100 }];
const TWO = [
  { file: "a-mid.glb", maxPoints: 300 },
  { file: "a-low.glb", maxPoints: 100 },
];

describe("modelLevel", () => {
  it("draws the copy up to its maxPoints and the file above it", () => {
    expect(modelLevel(72, 1, ISS)).toBe(1);
    expect(modelLevel(100, 1, ISS)).toBe(1);
    expect(modelLevel(101, 1, ISS)).toBe(0);
  });

  it("goes back to the copy only well below its maxPoints", () => {
    expect(modelLevel(90, 0, ISS)).toBe(0);
    expect(modelLevel(MODEL_LEVEL_HYSTERESIS * 100, 0, ISS)).toBe(0);
    expect(modelLevel(79, 0, ISS)).toBe(1);
  });

  it("steps over several copies at once", () => {
    expect(modelLevel(50, 0, TWO)).toBe(2);
    expect(modelLevel(500, 2, TWO)).toBe(0);
    expect(modelLevel(200, 2, TWO)).toBe(1);
    expect(modelLevel(200, 0, TWO)).toBe(1);
  });

  it("draws the file of a model without copies, whatever level it was asked about", () => {
    expect(modelLevel(10, 0, [])).toBe(0);
    expect(modelLevel(10, 3, [])).toBe(0);
  });
});
