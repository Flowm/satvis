import { describe, expect, test } from "vitest";

import { sameValue } from "./equality";

describe("sameValue", () => {
  test("primitives", () => {
    expect(sameValue("a", "a")).toBe(true);
    expect(sameValue("a", "b")).toBe(false);
    expect(sameValue(false, false)).toBe(true);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, "")).toBe(false);
  });

  test("equal lists that are not the same array", () => {
    expect(sameValue(["Weather", "GNSS"], ["Weather", "GNSS"])).toBe(true);
    expect(sameValue(["Weather", "GNSS"], ["GNSS", "Weather"])).toBe(false);
    expect(sameValue(["Weather"], ["Weather", "GNSS"])).toBe(false);
    expect(sameValue([], [])).toBe(true);
  });

  test("ground stations compare field by field", () => {
    expect(sameValue([{ lat: 48.1, lon: 11.5, name: "Munich" }], [{ lat: 48.1, lon: 11.5, name: "Munich" }])).toBe(true);
    expect(sameValue([{ lat: 48.1, lon: 11.5 }], [{ lat: 48.1, lon: 11.6 }])).toBe(false);
  });

  test("a missing key is not the same as an extra one", () => {
    expect(sameValue([{ lat: 1, lon: 2 }], [{ lat: 1, lon: 2, name: "x" }])).toBe(false);
    expect(sameValue({ lat: 1, lon: 2 }, { lon: 2, lat: 1 })).toBe(true);
  });

  test("mixed types never compare equal", () => {
    expect(sameValue(["a"], "a")).toBe(false);
    expect(sameValue({}, [])).toBe(false);
  });
});
