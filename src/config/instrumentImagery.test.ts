import { describe, expect, test } from "vitest";

import {
  COMPOSITE,
  drawnImagery,
  granulePictureUrl,
  imageryDetail,
  imageryLayers,
  imageryPreviewUrl,
  imageryRows,
  imageryType,
  imageryWords,
  previewBounds,
  readImagery,
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
    expect(drawnImagery(granule)).toMatchObject({
      daily: false,
      granules: ["C2208781576-LANCEMODIS", "C2105084593-LAADS"],
      pictures: { provider: "gibs", layer: granule.layer, frame: "granule" },
    });
    expect(drawnImagery({ ...granule, period: "P1D" })).not.toHaveProperty("granules");
    expect(drawnImagery({ ...granule, granules: [] })).not.toHaveProperty("granules");
    expect(drawnImagery({ ...granule, granules: "VJ103MOD" })).not.toHaveProperty("granules");
    expect(drawnImagery({ ...geoColour, granules: ["C2105084593-LAADS"] })).not.toHaveProperty("granules");
    // A EUMETView one says when its frame of a granule is stamped, or it is no granule layer.
    const swath = { ...geoColour, period: "PT3M", granules: ["EO:EUM:DAT:0409"], platform: "Sentinel-3A" };
    expect(drawnImagery(swath)).not.toHaveProperty("granules");
    expect(drawnImagery({ ...swath, frame: "PT25M" })).toMatchObject({
      granules: ["EO:EUM:DAT:0409"],
      platform: "Sentinel-3A",
      pictures: { provider: "eumetview", layer: geoColour.layer, frame: 25 * 60 * 1000 },
    });
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

  test("reads a cmr layer whose granules are cut from another layer's frames, and leaves out pictures that do not read", () => {
    const cut = {
      instrument: "OLI-2",
      provider: "cmr",
      layer: "HLSL30.LANDSAT-9",
      label: "True colour",
      kind: "rgb",
      period: "PT1M",
      granules: ["C2021957657-LPCLOUD"],
      platform: "LANDSAT-9",
      pictures: { provider: "gibs", layer: "HLS_L30_Nadir_BRDF_Adjusted_Reflectance", frame: "day" },
    };
    expect(drawnImagery(cut)).toEqual({
      token: "cmr:HLSL30.LANDSAT-9",
      provider: "cmr",
      layer: "HLSL30.LANDSAT-9",
      granules: ["C2021957657-LPCLOUD"],
      platform: "LANDSAT-9",
      pictures: { provider: "gibs", layer: "HLS_L30_Nadir_BRDF_Adjusted_Reflectance", frame: "day" },
    });
    expect(drawnImagery({ ...cut, pictures: { provider: "eumetview", layer: "eps:m01", frame: "PT35M" } })).toMatchObject({ pictures: { frame: 35 * 60 * 1000 } });
    expect(drawnImagery({ ...cut, pictures: { provider: "georing", layer: "x", frame: "day" } })).not.toHaveProperty("pictures");
    expect(drawnImagery({ ...cut, pictures: { provider: "gibs", layer: "x", frame: "daily" } })).not.toHaveProperty("pictures");
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

  test("names a granule's frame: by its start, by its day, or by when its frame is stamped", () => {
    const start = Date.parse("2026-11-20T23:55:00Z");
    const bounds = previewBounds({ latitude: -30, longitude: 145 }, 20);
    const preview = (provider: "gibs" | "eumetview", frame: "granule" | "day" | number) =>
      params(imageryPreviewUrl({ provider, layer: "a", format: "png", daily: false, pictures: { provider, layer: "a", frame }, granule: start }, bounds, now)).TIME;
    expect(preview("gibs", "granule")).toBe("2026-11-20T23:55:00Z");
    expect(preview("gibs", "day")).toBe("2026-11-20");
    expect(preview("eumetview", 25 * 60 * 1000)).toBe("2026-11-21T00:20:00Z");
  });
});

describe("granulePictureUrl", () => {
  const bounds = { west: 138, south: -35, east: 156, north: -21 };
  const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

  test("asks GIBS for the granule's own frame", () => {
    const url = granulePictureUrl({ provider: "gibs", layer: "a", frame: "granule" }, Date.parse("2026-11-21T10:06:00Z"), bounds, 2048, 1593);
    expect(url.startsWith("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?")).toBe(true);
    expect(params(url)).toMatchObject({ LAYERS: "a", TIME: "2026-11-21T10:06:00Z", FORMAT: "image/jpeg", BGCOLOR: "0x000000", BBOX: "138.000,-35.000,156.000,-21.000" });
  });

  test("asks GIBS for a daily layer's frame of the granule's day", () => {
    const url = granulePictureUrl({ provider: "gibs", layer: "a", frame: "day" }, Date.parse("2026-11-21T23:59:00Z"), bounds, 512, 398);
    expect(params(url).TIME).toBe("2026-11-21");
  });

  test("asks EUMETView for its pass's swath, black where it has none", () => {
    const url = granulePictureUrl({ provider: "eumetview", layer: "b", frame: 25 * 60 * 1000 }, Date.parse("2026-11-20T23:55:00Z"), bounds, 2048, 1593);
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
    expect(layers[0]).toMatchObject({ instrument: "ABI", type: "live", detail: "every 10 min" });
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

  test("lists a granule layer in its satellite's group as its passes", () => {
    const granules = {
      ...daily,
      instrument: "VIIRS",
      layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor_Granule",
      label: "True colour",
      period: "PT6M",
      granules: ["C2208781576-LANCEMODIS"],
    };
    const [layer] = imageryLayers([{ name: "NOAA 20", satnum: "43013", orbitClass: "LEO", metadata: { imagery: [granules] } }]);
    expect(layer).toMatchObject({ group: "leo", type: "passes", label: "True colour", words: { picture: "True colour · VIIRS" } });
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
          ? [layer.key, layer.name, layer.cadence, layer.type, layer.satellites, layer.detail]
          : [layer.key, layer.satellite, layer.instrument, layer.type, layer.detail],
      ),
    ).toEqual([
      ["georing:mosaic", "GeoRing", "hourly", "ring", ["GOES 19"], "hourly, last 7 days"],
      ["eumetview:mumi:wideareacoverage_rgb_natural", "GeoRing", "3-hourly", "ring", ["GOES 19", "METEOSAT-9 (MSG-2)"], "every 3 h since 2022"],
      ["60133:gibs:GOES-East_ABI_GeoColor", "GOES 19", "ABI", "live", "every 10 min, last 90 days"],
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

describe("imageryType", () => {
  const drawn = drawnImagery({ provider: "gibs", layer: "A", maxLevel: 9, format: "jpeg", period: "P1D" });
  const granules = drawnImagery({ provider: "cmr", layer: "MOD03", granules: ["C1"] });

  test.each([
    ["a granule layer", { label: "True colour", period: "PT5M", merged: false, drawn: granules }, "passes"],
    ["a day a frame", { label: "True colour", period: "P1D", merged: false, drawn }, "daily"],
    ["Metop's stacked orbits, which have no period", { label: "Natural colour and fog, six orbits stacked", merged: false, drawn }, "orbits"],
    ["a frame every few minutes", { label: "GeoColor", period: "PT10M", merged: false, drawn }, "live"],
    ["a composite the globe draws", { label: "Day/Night, GeoRing", period: "PT1H", merged: true, drawn }, "ring"],
    ["a composite of viewer links alone", { label: "True colour scenes", merged: true }, "scenes"],
  ])("names %s", (_, entry, type) => {
    expect(imageryType(entry)).toBe(type);
  });
});

describe("imageryWords", () => {
  test("says the picture's colours, then its instrument, with the qualifier the type does not say", () => {
    expect(imageryWords({ type: "daily", instrument: "MISR", label: "True colour, nadir camera" }).picture).toBe("True colour (nadir camera) · MISR");
    expect(imageryWords({ type: "orbits", instrument: "AVHRR/3", label: "Natural colour and fog, six orbits stacked" }).picture).toBe("Natural colour + fog · AVHRR/3");
    expect(imageryWords({ type: "ring", instrument: "FCI", label: "Day/Night, GeoRing", merged: true }).picture).toBe("Day/Night · FCI and others");
  });

  test("says how often it updates, by its type or its period, or the day it ended", () => {
    expect(imageryWords({ type: "passes", instrument: "VIIRS", label: "True colour", period: "PT6M" }).updates).toBe("With each pass, hours behind live");
    expect(imageryWords({ type: "daily", instrument: "MODIS", label: "True colour", period: "P1D" }).updates).toBe("Once a day");
    expect(imageryWords({ type: "live", instrument: "ABI", label: "GeoColor", period: "PT10M" }).updates).toBe("Every 10 min");
    expect(imageryWords({ type: "ring", instrument: "ABI", label: "Day/Night", period: "PT1H" }).updates).toBe("Hourly");
    expect(imageryWords({ type: "daily", instrument: "HARP2", label: "True colour", period: "P1D", start: "2025-08-21", end: "2026-06-19" })).toMatchObject({
      updates: "Ended Jun 19, 2026",
      ended: true,
    });
  });

  test("says how far back it goes, a layer that stopped from when to when", () => {
    const words = (dates: { start?: string; end?: string; window?: string }) => imageryWords({ type: "daily", instrument: "X", label: "True colour", ...dates }).archive;
    expect(words({ start: "2002-07-03" })).toBe("Back to 2002");
    expect(words({ start: "2024-09-23", window: "P90D" })).toBe("The last 90 days");
    expect(words({ start: "2017-09-01", end: "2022-10-12" })).toBe("2017–2022");
    expect(words({ start: "2025-08-21", end: "2025-12-01" })).toBe("2025");
    expect(words({})).toBeUndefined();
  });
});

describe("imageryRows", () => {
  const entry = (instrument: string, period: string, extra: object = {}) => ({
    instrument,
    provider: "gibs",
    layer: `${instrument}-${period}-${JSON.stringify(extra)}`,
    label: "True colour",
    kind: "rgb",
    period,
    maxLevel: 7,
    format: "jpeg",
    ...extra,
  });
  const rows = (records: { name: string; orbitClass?: "LEO" | "GEO"; imagery: object[] }[]) =>
    imageryRows(imageryLayers(records.map(({ name, orbitClass = "LEO", imagery }) => ({ name, satnum: name, orbitClass, metadata: { imagery } }))));
  const named = (list: ReturnType<typeof imageryRows>) => list.map((row) => [row.name, row.cells.map(({ layer, name, extra }) => [layer.type, name, extra])]);

  test("gives a satellite one row, the picture that shows at once first and its passes last", () => {
    const passes = { instrument: "MODIS", provider: "cmr", layer: "MYD03", label: "True colour", kind: "rgb", period: "PT5M", granules: ["C1"] };
    expect(
      named(
        rows([
          { name: "AQUA", imagery: [passes, entry("MODIS", "P1D")] },
          { name: "NOAA 20", imagery: [entry("VIIRS", "P1D")] },
        ]),
      ),
    ).toEqual([
      [
        "AQUA",
        [
          ["daily", "Daily", false],
          ["passes", "Passes", false],
        ],
      ],
      ["NOAA 20", [["daily", "Daily", false]]],
    ]);
  });

  test("names a second layer of a type by its instrument, or by its colours where the instrument is the same", () => {
    const [meteosat, pace] = rows([
      { name: "PACE", imagery: [entry("OCI", "P1D"), entry("SPEXone", "P1D")] },
      { name: "METEOSAT-12", orbitClass: "GEO", imagery: [entry("FCI", "PT10M", { label: "GeoColour" }), entry("FCI", "PT10M", { label: "True colour" })] },
    ]);
    expect(pace!.cells.map(({ name, extra }) => [name, extra])).toEqual([
      ["Daily", false],
      ["SPEXone", true],
    ]);
    expect(meteosat!.cells.map(({ name, extra }) => [name, extra])).toEqual([
      ["Live", false],
      ["True", true],
    ]);
  });

  test("gives a composite one row, first, with a button for each of its layers named by its cadence", () => {
    const ring = { provider: "georing", layer: "mosaic", label: "Day/Night, GeoRing", kind: "rgb", period: "PT1H", maxLevel: 8, format: "webp", merged: true, instrument: "ABI" };
    const natural = { ...ring, provider: "eumetview", layer: "mumi", label: "Natural colour, GeoRing", period: "PT3H" };
    const [first, goes] = rows([{ name: "GOES 19", orbitClass: "GEO", imagery: [entry("ABI", "PT10M"), ring, natural] }]);
    expect(first).toMatchObject({ name: "GeoRing", composite: { kind: "composite" } });
    expect(first!.cells.map(({ name }) => name)).toEqual(["Hourly", "3-hourly"]);
    expect(goes!.cells.map(({ name }) => name)).toEqual(["Live"]);
  });
});
