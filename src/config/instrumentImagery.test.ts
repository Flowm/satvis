import { describe, expect, test } from "vitest";

import {
  COMPOSITE,
  drawnImagery,
  granulePictureUrl,
  imageryDetail,
  imageryLayers,
  imageryPreviewUrl,
  previewBounds,
  readImagery,
  RECORDED_SWATH,
  shortImageryLabel,
} from "./instrumentImagery";

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

  test("reads the CMR collections of a GIBS or EUMETView layer replayed granule by granule, and of no other", () => {
    const granule = {
      ...trueColour,
      layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor_Granule",
      period: "PT6M",
      format: "png",
      granules: ["C2208781576-LANCEMODIS", "C2105084593-LAADS"],
    };
    expect(drawnImagery(granule)).toMatchObject({ daily: false, granules: ["C2208781576-LANCEMODIS", "C2105084593-LAADS"] });
    expect(drawnImagery({ ...granule, period: "P1D" })).not.toHaveProperty("granules");
    expect(drawnImagery({ ...granule, granules: [] })).not.toHaveProperty("granules");
    expect(drawnImagery({ ...granule, granules: "VJ103MOD" })).not.toHaveProperty("granules");
    expect(drawnImagery({ ...geoColour, granules: ["C2105084593-LAADS"] })).not.toHaveProperty("granules");
    expect(drawnImagery({ ...geoColour, period: "PT3M", granules: ["C1577017384-OB_DAAC"] })).toMatchObject({ provider: "eumetview", granules: ["C1577017384-OB_DAAC"] });
  });

  test("reads a cmr layer as its granule outlines, without tiles", () => {
    const outlines = {
      instrument: "VIIRS",
      provider: "cmr",
      layer: "VJ203MOD",
      label: "Granule outlines",
      kind: "outline",
      period: "PT6M",
      granules: ["C3383721151-LANCEMODIS", "C3478458790-LAADS"],
    };
    expect(drawnImagery(outlines)).toEqual({ token: "cmr:VJ203MOD", provider: "cmr", layer: "VJ203MOD", granules: ["C3383721151-LANCEMODIS", "C3478458790-LAADS"] });
    expect(drawnImagery({ ...outlines, granules: [] })).toBeUndefined();
    expect(readImagery(outlines)).toMatchObject({ detail: "every 6 min", drawn: { token: "cmr:VJ203MOD" } });
    expect(readImagery(outlines)).not.toHaveProperty("href");
  });

  test("reads a EUMETView entry, whose service names its own frames, with or without a period", () => {
    expect(drawnImagery(geoColour)).toEqual({ token: "eumetview:mtg_fd:rgb_geocolour", provider: "eumetview", layer: geoColour.layer, maxLevel: 7, format: "png", daily: false });
    expect(drawnImagery({ ...geoColour, period: "PT10M" })).toMatchObject({ provider: "eumetview", daily: false });
  });

  test.each([
    ["a provider that only has a viewer", { ...trueColour, provider: "copernicus-browser" }],
    ["no tile set", { ...trueColour, maxLevel: undefined }],
    ["a tile type it does not draw", { ...trueColour, format: "gif" }],
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
    const url = imageryPreviewUrl(
      { provider: "gibs", layer: "MODIS_Terra_CorrectedReflectance_TrueColor", format: "jpeg", daily: true },
      previewBounds({ latitude: 10, longitude: 20 }, 32),
      now,
    );
    expect(url.startsWith("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?")).toBe(true);
    expect(params(url)).toMatchObject({ LAYERS: "MODIS_Terra_CorrectedReflectance_TrueColor", FORMAT: "image/jpeg", TIME: "2026-11-11", BBOX: "-12.00,-8.00,52.00,28.00" });
  });

  test("shows a stopped layer's last frame, and a sub-daily one's latest", () => {
    expect(
      params(imageryPreviewUrl({ provider: "gibs", layer: "a", format: "jpeg", daily: true, end: "2026-11-02" }, previewBounds({ latitude: 0, longitude: 0 }, 32), now)).TIME,
    ).toBe("2026-11-02");
    expect(params(imageryPreviewUrl({ provider: "gibs", layer: "a", format: "png", daily: false }, previewBounds({ latitude: 0, longitude: 0 }, 32), now)).TIME).toBeUndefined();
  });

  test("keeps a polar orbiter's centre off the pole", () => {
    const url = imageryPreviewUrl({ provider: "gibs", layer: "a", format: "jpeg", daily: true }, previewBounds({ latitude: -85, longitude: 0 }, 32), now);
    expect(params(url).BBOX).toBe("-32.00,-68.00,32.00,-32.00");
  });

  test("asks EUMETView for a transparent picture", () => {
    const url = imageryPreviewUrl({ provider: "eumetview", layer: "mtg_fd:rgb_geocolour", format: "png", daily: false }, previewBounds({ latitude: 0, longitude: 0 }, 72), now);
    expect(url.startsWith("https://view.eumetsat.int/geoserver/ows?")).toBe(true);
    expect(params(url)).toMatchObject({ LAYERS: "mtg_fd:rgb_geocolour", FORMAT: "image/png", TRANSPARENT: "TRUE" });
  });

  test("names a granule's frame: GIBS by its start, EUMETView by when its pass ended, which its swath is stamped nearest", () => {
    const start = Date.parse("2026-11-20T23:55:00Z");
    const bounds = previewBounds({ latitude: -30, longitude: 145 }, 20);
    expect(params(imageryPreviewUrl({ provider: "gibs", layer: "a", format: "png", daily: false, granule: start }, bounds, now)).TIME).toBe("2026-11-20T23:55:00Z");
    expect(params(imageryPreviewUrl({ provider: "eumetview", layer: "b", format: "png", daily: false, granule: start }, bounds, now)).TIME).toBe("2026-11-21T00:20:00Z");
  });
});

describe("granulePictureUrl", () => {
  const bounds = { west: 138, south: -35, east: 156, north: -21 };
  const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

  test("asks GIBS for the granule's own frame", () => {
    const url = granulePictureUrl({ provider: "gibs", layer: "a" }, Date.parse("2026-11-21T10:06:00Z"), bounds, 2048, 1593);
    expect(url.startsWith("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?")).toBe(true);
    expect(params(url)).toMatchObject({ LAYERS: "a", TIME: "2026-11-21T10:06:00Z", FORMAT: "image/jpeg", BBOX: "138.000,-35.000,156.000,-21.000" });
    expect(params(url)).not.toHaveProperty("BGCOLOR");
  });

  test("asks EUMETView for its pass's swath, black where it has none", () => {
    const url = granulePictureUrl({ provider: "eumetview", layer: "b" }, Date.parse("2026-11-20T23:55:00Z"), bounds, 2048, 1593);
    expect(url.startsWith("https://view.eumetsat.int/geoserver/ows?")).toBe(true);
    expect(params(url)).toMatchObject({ LAYERS: "b", TIME: "2026-11-21T00:20:00Z", FORMAT: "image/jpeg", BGCOLOR: "0x000000" });
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

  test("groups the layers the globe draws by the satellite's orbit, by satellite name, and leaves out those that stopped", () => {
    const layers = imageryLayers([
      { name: "TERRA", satnum: "25994", orbitClass: "LEO", metadata: { imagery: [daily, ended] } },
      { name: "GOES 19", satnum: "60133", orbitClass: "GEO", metadata: { imagery: [geoColor] } },
      { name: "SENTINEL-2A", satnum: "40697", orbitClass: "LEO", metadata: { imagery: [scenes] } },
    ]);
    expect(layers.map((layer) => [layer.kind === "satellite" && layer.satellite, layer.label, layer.group, layer.token])).toEqual([
      ["GOES 19", "GeoColor", "geo", "gibs:GOES-East_ABI_GeoColor"],
      ["TERRA", "True colour", "leo", "gibs:MODIS_Terra_CorrectedReflectance_TrueColor"],
    ]);
    expect(layers[0]).toMatchObject({ instrument: "ABI", product: "GeoColor", detail: "every 10 min" });
  });

  test("lists a satellite's layer once, however many groups carry it, and leaves out an entry the Imagery tab would", () => {
    const layers = imageryLayers([
      { name: "GOES 19", satnum: "60133", orbitClass: "GEO", metadata: { imagery: [geoColor] } },
      {
        name: "GOES 19",
        satnum: "60133",
        orbitClass: "GEO",
        metadata: { imagery: [geoColor, { ...geoColor, provider: "elsewhere" }, { ...geoColor, layer: 7 }, { ...geoColor, layer: "No_Instrument", instrument: undefined }, null] },
      },
      { name: "NO IMAGERY", satnum: "1", orbitClass: "LEO", metadata: {} },
    ]);
    expect(layers.map((layer) => layer.key)).toEqual(["60133:gibs:GOES-East_ABI_GeoColor"]);
  });

  test("lists a granule layer in its satellite's group, named for the swath it shows", () => {
    const granules = {
      ...daily,
      instrument: "VIIRS",
      layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor_Granule",
      label: "True colour",
      period: "PT6M",
      granules: ["C2208781576-LANCEMODIS"],
    };
    const [layer] = imageryLayers([{ name: "NOAA 20", satnum: "43013", orbitClass: "LEO", metadata: { imagery: [granules] } }]);
    expect(layer).toMatchObject({ group: "leo", product: RECORDED_SWATH, label: "True colour" });
  });
});

describe("imageryLayers of composites", () => {
  const ring = {
    provider: "eumetview",
    layer: "mumi:wideareacoverage_rgb_natural",
    label: "Natural colour, GeoRing",
    kind: "rgb",
    period: "PT3H",
    maxLevel: 6,
    format: "png",
    merged: true,
  };
  const mosaic = {
    provider: "georing",
    layer: "mosaic",
    label: "Day/Night, GeoRing",
    kind: "rgb",
    period: "PT1H",
    window: "P7D",
    maxLevel: 8,
    format: "webp",
    merged: true,
  };
  const goes = {
    provider: "gibs",
    layer: "GOES-East_ABI_GeoColor",
    label: "GeoColor",
    kind: "rgb",
    period: "PT10M",
    window: "P90D",
    maxLevel: 7,
    format: "png",
    instrument: "ABI",
  };

  test("lists a composite once, first, named by its label's qualifier, from its earliest satellite's start", () => {
    const layers = imageryLayers([
      { name: "GOES 19", satnum: "60133", orbitClass: "GEO", metadata: { imagery: [goes, { ...ring, instrument: "ABI", start: "2025-04-07" }, { ...mosaic, instrument: "ABI" }] } },
      { name: "METEOSAT-9 (MSG-2)", satnum: "28912", orbitClass: "GEO", metadata: { imagery: [{ ...ring, instrument: "SEVIRI", start: "2022-06-01" }] } },
      { name: "GOES 19", satnum: "60133", orbitClass: "GEO", metadata: { imagery: [{ ...ring, instrument: "ABI", start: "2025-04-07" }] } },
    ]);
    expect(
      layers.map((layer) =>
        layer.kind === "composite"
          ? [layer.key, layer.name, layer.cadence, layer.product, layer.satellites, layer.detail]
          : [layer.key, layer.satellite, layer.instrument, layer.product, layer.detail],
      ),
    ).toEqual([
      ["georing:mosaic", "GeoRing", "hourly", "Day/Night", ["GOES 19"], "hourly, last 7 days"],
      ["eumetview:mumi:wideareacoverage_rgb_natural", "GeoRing", "3-hourly", "Natural", ["GOES 19", "METEOSAT-9 (MSG-2)"], "every 3 h since 2022"],
      ["60133:gibs:GOES-East_ABI_GeoColor", "GOES 19", "ABI", "GeoColor", "every 10 min, last 90 days"],
    ]);
  });

  test("names a composite with no qualifier Composite", () => {
    const [layer] = imageryLayers([
      { name: "A", satnum: "1", orbitClass: "GEO", metadata: { imagery: [{ ...ring, label: "Natural colour", instrument: "X" }] } },
      { name: "B", satnum: "2", orbitClass: "GEO", metadata: { imagery: [{ ...ring, label: "Natural colour", instrument: "Y" }] } },
    ]);
    expect(layer).toMatchObject({ kind: "composite", name: COMPOSITE, satellites: ["A", "B"] });
  });
});

describe("shortImageryLabel", () => {
  test("keeps what the picture is, without the qualifiers or the word colour", () => {
    expect(shortImageryLabel("True colour")).toBe("True");
    expect(shortImageryLabel("True colour, one swath per orbit")).toBe("True");
    expect(shortImageryLabel("Natural colour, Europe")).toBe("Natural");
    expect(shortImageryLabel("Natural colour and fog, six orbits stacked")).toBe("Natural + fog");
    expect(shortImageryLabel("GeoColor")).toBe("GeoColor");
    expect(shortImageryLabel("GeoColour")).toBe("GeoColour");
  });

  test("keeps a label it would empty", () => {
    expect(shortImageryLabel("Colour")).toBe("Colour");
  });
});
