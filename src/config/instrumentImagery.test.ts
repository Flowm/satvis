import { describe, expect, test } from "vitest";

import { drawnImagery, imageryDetail } from "./instrumentImagery";

describe("imageryDetail", () => {
  test.each([
    [{ period: "P1D", start: "2018-01-05" }, "daily since 2018"],
    [{ period: "P1D", start: "2017-09-01", end: "2022-10-12" }, "daily, 2017–2022"],
    [{ period: "P1D", start: "2025-08-21", end: "2025-12-19" }, "daily, 2025"],
    [{ period: "PT10M", window: "P90D" }, "every 10 min, last 90 days"],
    [{ period: "P1D", end: "2022-10-12" }, "daily, until 2022"],
    [{ period: "PT6M", window: "P90D", end: "2026-11-02" }, "every 6 min, until 2026"],
    [{ start: "2020-02-17" }, "since 2020"],
    [{ merged: true as const }, "with other satellites"],
    // A period that is neither a day nor minutes, and a window not in days, are not put into words.
    [{ period: "P8D", start: "2020-09-01", window: "P3M" }, "since 2020"],
  ])("%j", (entry, detail) => {
    expect(imageryDetail(entry)).toBe(detail);
  });

  test("says nothing where the entry does not", () => {
    expect(imageryDetail({})).toBeUndefined();
  });
});

describe("drawnImagery", () => {
  const trueColour = {
    instrument: "VIIRS",
    provider: "gibs",
    layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
    label: "True colour",
    kind: "rgb",
    period: "P1D",
    maxLevel: 9,
    format: "jpeg",
  };

  test("reads what the globe needs of a GIBS entry", () => {
    expect(drawnImagery(trueColour)).toEqual({ token: "gibs:VIIRS_NOAA20_CorrectedReflectance_TrueColor", layer: trueColour.layer, maxLevel: 9, format: "jpeg", daily: true });
    expect(drawnImagery({ ...trueColour, period: "PT10M", format: "png" })).toMatchObject({ format: "png", daily: false });
  });

  test.each([
    ["another provider", { ...trueColour, provider: "eumetview" }],
    ["no tile set", { ...trueColour, maxLevel: undefined }],
    ["a tile type it does not draw", { ...trueColour, format: "webp" }],
    ["a step its time layer does not know", { ...trueColour, period: "PT15M" }],
    ["no step", { ...trueColour, period: undefined }],
    ["no entry", "gibs"],
  ])("draws nothing of %s", (_, entry) => {
    expect(drawnImagery(entry)).toBeUndefined();
  });
});
