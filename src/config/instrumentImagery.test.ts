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
  const geoColour = { instrument: "FCI", provider: "eumetview", layer: "mtg_fd:rgb_geocolour", label: "GeoColour", kind: "rgb", maxLevel: 7, format: "png" };

  test("reads what the globe needs of a GIBS entry", () => {
    expect(drawnImagery(trueColour)).toEqual({
      token: "gibs:VIIRS_NOAA20_CorrectedReflectance_TrueColor",
      provider: "gibs",
      layer: trueColour.layer,
      maxLevel: 9,
      format: "jpeg",
      daily: true,
    });
    expect(drawnImagery({ ...trueColour, period: "PT10M", format: "png" })).toMatchObject({ format: "png", daily: false });
  });

  test("reads a EUMETView entry, whose service names its own frames, with or without a period", () => {
    expect(drawnImagery(geoColour)).toEqual({ token: "eumetview:mtg_fd:rgb_geocolour", provider: "eumetview", layer: geoColour.layer, maxLevel: 7, format: "png", daily: false });
    expect(drawnImagery({ ...geoColour, period: "PT10M" })).toMatchObject({ provider: "eumetview", daily: false });
  });

  test.each([
    ["a provider that only has a viewer", { ...trueColour, provider: "copernicus-browser" }],
    ["no tile set", { ...trueColour, maxLevel: undefined }],
    ["a tile type it does not draw", { ...trueColour, format: "webp" }],
    ["a GIBS period that does not say how its frames are named", { ...trueColour, period: "P1M" }],
    ["a GIBS entry with no period", { ...trueColour, period: undefined }],
    ["no entry", "gibs"],
  ])("draws nothing of %s", (_, entry) => {
    expect(drawnImagery(entry)).toBeUndefined();
  });
});
