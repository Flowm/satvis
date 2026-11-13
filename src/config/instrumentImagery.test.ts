import { describe, expect, test } from "vitest";

import { drawnImagery, imageryDetail, imageryLayers, imageryPreviewUrl } from "./instrumentImagery";

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

describe("imageryPreviewUrl", () => {
  const now = new Date("2026-11-12T03:00:00Z");
  const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

  test("asks GIBS for yesterday's frame of a daily layer, around the centre", () => {
    const url = imageryPreviewUrl({ provider: "gibs", layer: "MODIS_Terra_CorrectedReflectance_TrueColor", format: "jpeg", daily: true }, { latitude: 10, longitude: 20 }, 32, now);
    expect(url.startsWith("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?")).toBe(true);
    expect(params(url)).toMatchObject({ LAYERS: "MODIS_Terra_CorrectedReflectance_TrueColor", FORMAT: "image/jpeg", TIME: "2026-11-11", BBOX: "-12.00,-8.00,52.00,28.00" });
  });

  test("shows a stopped layer's last frame, and a sub-daily one's latest", () => {
    expect(params(imageryPreviewUrl({ provider: "gibs", layer: "a", format: "jpeg", daily: true, end: "2026-11-02" }, { latitude: 0, longitude: 0 }, 32, now)).TIME).toBe(
      "2026-11-02",
    );
    expect(params(imageryPreviewUrl({ provider: "gibs", layer: "a", format: "png", daily: false }, { latitude: 0, longitude: 0 }, 32, now)).TIME).toBeUndefined();
  });

  test("keeps a polar orbiter's centre off the pole", () => {
    const url = imageryPreviewUrl({ provider: "gibs", layer: "a", format: "jpeg", daily: true }, { latitude: -85, longitude: 0 }, 32, now);
    expect(params(url).BBOX).toBe("-32.00,-68.00,32.00,-32.00");
  });

  test("asks EUMETView for a transparent picture", () => {
    const url = imageryPreviewUrl({ provider: "eumetview", layer: "mtg_fd:rgb_geocolour", format: "png", daily: false }, { latitude: 0, longitude: 0 }, 72, now);
    expect(url.startsWith("https://view.eumetsat.int/geoserver/ows?")).toBe(true);
    expect(params(url)).toMatchObject({ LAYERS: "mtg_fd:rgb_geocolour", FORMAT: "image/png", TRANSPARENT: "TRUE" });
  });
});

describe("imageryLayers", () => {
  const geoColor = { instrument: "ABI", provider: "gibs", layer: "GOES-East_ABI_GeoColor", label: "GeoColor", kind: "rgb", period: "PT10M", maxLevel: 7, format: "png" };
  const daily = {
    instrument: "MODIS",
    provider: "gibs",
    layer: "MODIS_Terra_CorrectedReflectance_TrueColor",
    label: "True colour",
    kind: "rgb",
    period: "P1D",
    maxLevel: 9,
    format: "jpeg",
  };
  const ended = { ...daily, layer: "MISR_AM1_Ellipsoid_Radiance_RGB_AN", instrument: "MISR", label: "True colour, nadir camera", end: "2022-10-12" };
  const scenes = { instrument: "MSI", provider: "copernicus-browser", layer: "S2_L2A", label: "True colour scenes", kind: "rgb" };

  test("groups the layers by how often they have frames, the links apart, by satellite name", () => {
    const layers = imageryLayers([
      { name: "TERRA", satnum: "25994", metadata: { imagery: [daily, ended] } },
      { name: "GOES 19", satnum: "60133", metadata: { imagery: [geoColor] } },
      { name: "SENTINEL-2A", satnum: "40697", metadata: { imagery: [scenes] } },
    ]);
    expect(layers.map((layer) => [layer.satellite, layer.label, layer.group, layer.token])).toEqual([
      ["GOES 19", "GeoColor", "weather", "gibs:GOES-East_ABI_GeoColor"],
      ["SENTINEL-2A", "True colour scenes", "viewer", undefined],
      ["TERRA", "True colour", "polar", "gibs:MODIS_Terra_CorrectedReflectance_TrueColor"],
      ["TERRA", "True colour, nadir camera", "ended", "gibs:MISR_AM1_Ellipsoid_Radiance_RGB_AN"],
    ]);
    expect(layers[0]).toMatchObject({ detail: "every 10 min", viewer: "NASA Worldview", href: "https://worldview.earthdata.nasa.gov/?l=GOES-East_ABI_GeoColor" });
  });

  test("lists a satellite's layer once, however many groups carry it, and leaves out an entry the Imagery tab would", () => {
    const layers = imageryLayers([
      { name: "GOES 19", satnum: "60133", metadata: { imagery: [geoColor] } },
      {
        name: "GOES 19",
        satnum: "60133",
        metadata: { imagery: [geoColor, { ...geoColor, provider: "elsewhere" }, { ...geoColor, layer: 7 }, { ...geoColor, layer: "No_Instrument", instrument: undefined }, null] },
      },
      { name: "NO IMAGERY", satnum: "1", metadata: {} },
    ]);
    expect(layers.map((layer) => layer.key)).toEqual(["60133:gibs:GOES-East_ABI_GeoColor"]);
  });
});
