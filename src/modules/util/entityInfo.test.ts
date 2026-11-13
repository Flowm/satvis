import { describe, expect, test } from "vitest";

import Orbit from "@/modules/Orbit";

import { formatEpoch, getElementsInfo, getSatelliteInfo, type SatelliteInfo, staleElementsNotice, STALE_ELEMENTS_DAYS } from "./entityInfo";
import { parseGpPayload, type GpRecord } from "./gp";

/**
 * Not sun-synchronous, so the only derived row after the class is the apsides.
 * orbitFacts.test.ts covers the derivation.
 */
const ISS = new Orbit(
  "ISS (ZARYA)",
  parseGpPayload(
    "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658",
  )[0] as GpRecord,
);

/** Both tabs' rows, as the native app lists them. */
function rowsOf({ orbitRows, spacecraftRows }: SatelliteInfo): [string, string][] {
  return [...orbitRows, ...spacecraftRows];
}

function labels(info: SatelliteInfo): string[] {
  return rowsOf(info).map(([label]) => label);
}

function valueOf(info: SatelliteInfo, label: string): string | undefined {
  return rowsOf(info).find(([rowLabel]) => rowLabel === label)?.[1];
}

describe("formatEpoch", () => {
  test("formats a julian date as UTC timestamp", () => {
    // JD 2460000.5 == 2023-02-25T00:00:00Z
    expect(formatEpoch(2460000.5)).toBe("2023-02-25 00:00:00");
  });
});

describe("staleElementsNotice", () => {
  const DAY_MS = 86_400_000;
  const epochMs = getElementsInfo(ISS).epochMs;

  test("places the epoch in Unix milliseconds", () => {
    // 18342.69352573: day 342 of 2018 is December 8.
    expect(new Date(epochMs).toISOString()).toMatch(/^2018-12-08T16:38:40/);
  });

  test("stays quiet within the threshold, either side of the epoch", () => {
    expect(staleElementsNotice(epochMs, epochMs)).toBeUndefined();
    expect(staleElementsNotice(epochMs, epochMs + STALE_ELEMENTS_DAYS * DAY_MS)).toBeUndefined();
    expect(staleElementsNotice(epochMs, epochMs - STALE_ELEMENTS_DAYS * DAY_MS)).toBeUndefined();
  });

  test("names the offset and its direction past the threshold", () => {
    expect(staleElementsNotice(epochMs, epochMs + 30.4 * DAY_MS)).toBe("Position and passes may be inaccurate, clock 30 days after element epoch");
    expect(staleElementsNotice(epochMs, epochMs - 15 * DAY_MS)).toBe("Position and passes may be inaccurate, clock 15 days before element epoch");
  });
});

describe("getSatelliteInfo", () => {
  // 6786907: the chips asked for an "Owner" row that GCAT's Country had replaced.
  test("heads the panel with the orbit and the country, from the facts themselves", () => {
    const info = getSatelliteInfo(ISS, "LEO", { country: "USA", opsStatus: "+", operator: "NASA" });
    expect(info.orbitClass).toBe("LEO");
    expect(info.chips).toEqual(["LEO", "USA"]);
    expect(info.status).toBeUndefined();
  });

  test("leaves out an Unknown status, which says nothing", () => {
    const info = getSatelliteInfo(ISS, "LEO", { country: "USA", opsStatus: "?" });
    expect(info.chips).toEqual(["LEO", "USA"]);
    expect(info.status).toBeUndefined();
  });

  test("adds the status only when it is not Operational, and still lists Operational as a row", () => {
    const info = getSatelliteInfo(ISS, "LEO", { country: "USA", opsStatus: "-" });
    expect(info.chips).toEqual(["LEO", "USA", "Nonoperational"]);
    expect(info.status).toBe("Nonoperational");
    expect(valueOf(getSatelliteInfo(ISS, "LEO", { opsStatus: "+" }), "Status")).toBe("Operational");
  });

  test("leaves out a chip the record has nothing for", () => {
    expect(getSatelliteInfo(ISS, "MEO", {}).chips).toEqual(["MEO"]);
  });

  test("reports the derived rows even with no metadata, class first", () => {
    expect(labels(getSatelliteInfo(ISS, "LEO", {}))).toEqual(["Orbit", "Apogee / Perigee"]);
    expect(valueOf(getSatelliteInfo(ISS, "LEO", {}), "Orbit")).toBe("LEO");
  });

  test("splits where it flies from what it is", () => {
    const info = getSatelliteInfo(ISS, "LEO", { swathStarboardKm: 50, swathPortKm: 50, bus: "77KS", orbitType: "DOC" });
    expect(info.orbitRows.map(([label]) => label)).toEqual(["Orbit", "Apogee / Perigee"]);
    expect(info.spacecraftRows.map(([label]) => label)).toEqual(["Swath", "Bus", "Orbit type"]);
  });

  test("lists the instruments apart from the facts, each with the rows CEOS gives it", () => {
    const modis = {
      name: "MODIS",
      fullName: "MODerate-Resolution Imaging Spectroradiometer",
      kind: "Medium-resolution spectro-radiometer",
      bands: ["VIS", "TIR"],
      resolutionM: 250,
      nominalSwathKm: 2330,
    };
    const info = getSatelliteInfo(ISS, "LEO", { instruments: [modis, { name: "GEDI" }, { name: "TROPOMI", resolutionM: 3500, retired: true }] });
    expect(info.instruments).toEqual([
      {
        name: "MODIS",
        fullName: "MODerate-Resolution Imaging Spectroradiometer",
        retired: false,
        rows: [
          ["Kind", "Medium-resolution spectro-radiometer"],
          ["Bands", "VIS · TIR"],
          ["Resolution", "250 m"],
          ["Nominal swath", "2,330 km"],
        ],
        bands: ["VIS", "TIR"],
        imagery: [],
      },
      { name: "GEDI", retired: false, rows: [], bands: [], imagery: [] },
      { name: "TROPOMI", retired: true, rows: [["Resolution", "3.5 km"]], bands: [], imagery: [] },
    ]);
    expect(labels(info)).toEqual(["Orbit", "Apogee / Perigee"]);
    expect(getSatelliteInfo(ISS, "LEO", {}).instruments).toEqual([]);
  });

  test("gives no nominal swath off a low orbit, where nothing sweeps", () => {
    for (const orbitClass of ["MEO", "GEO", "HEO"] as const) {
      const [ahi] = getSatelliteInfo(ISS, orbitClass, { instruments: [{ name: "AHI", resolutionM: 500, nominalSwathKm: 500 }] }).instruments;
      expect(ahi!.rows, orbitClass).toEqual([["Resolution", "500 m"]]);
    }
  });

  // A curated row can give any shape; SatelliteDetailsTests.swift holds the native app to the same.
  test("reads malformed instruments as the native app does, leaving out what is not of its type", () => {
    const malformed = [
      { fullName: "No name" },
      "MODIS",
      { name: 7 },
      { name: "GEDI", fullName: 3, kind: null, bands: ["NIR", 2, null], resolutionM: null, nominalSwathKm: "4", retired: "yes" },
      { name: "EMIT", bands: "SWIR", resolutionM: "60" },
    ];
    expect(getSatelliteInfo(ISS, "LEO", { instruments: malformed as never }).instruments).toEqual([
      { name: "GEDI", retired: false, rows: [["Bands", "NIR"]], bands: ["NIR"], imagery: [] },
      { name: "EMIT", retired: false, rows: [], bands: [], imagery: [] },
    ]);
    expect(getSatelliteInfo(ISS, "LEO", { instruments: "MODIS" as never }).instruments).toEqual([]);
  });

  test("gives each instrument the imagery that shows it, as links to the providers it knows", () => {
    const imagery = [
      { instrument: "MODIS", provider: "gibs", layer: "MODIS_Terra_CorrectedReflectance_TrueColor", label: "True colour", kind: "rgb", period: "P1D", start: "2000-02-24" },
      {
        instrument: "MISR",
        provider: "gibs",
        layer: "MISR_AM1_Ellipsoid_Radiance_RGB_AN",
        label: "True colour, camera An",
        kind: "rgb",
        period: "P1D",
        start: "2017-09-01",
        end: "2022-10-12",
      },
      { instrument: "MODIS", provider: "eumetview", layer: "msg_fes:rgb natural", label: "Natural colour", kind: "rgb" },
      { instrument: "MODIS", provider: "elsewhere", layer: "a", label: "A", kind: "rgb" },
      { instrument: "ASTER", provider: "gibs", layer: "a", label: "Of an instrument it does not carry", kind: "rgb" },
    ];
    const info = getSatelliteInfo(ISS, "LEO", { instruments: [{ name: "MODIS" }, { name: "MISR" }, { name: "CERES" }], imagery });

    expect(info.instruments.map((instrument) => instrument.imagery)).toEqual([
      [
        {
          label: "True colour",
          detail: "daily since 2000",
          viewer: "NASA Worldview",
          href: "https://worldview.earthdata.nasa.gov/?l=MODIS_Terra_CorrectedReflectance_TrueColor",
        },
        { label: "Natural colour", viewer: "EUMETView", href: "https://view.eumetsat.int/productviewer?v=msg_fes:rgb%20natural" },
      ],
      [
        {
          label: "True colour, camera An",
          detail: "daily, 2017–2022",
          viewer: "NASA Worldview",
          href: "https://worldview.earthdata.nasa.gov/?l=MISR_AM1_Ellipsoid_Radiance_RGB_AN&t=2022-10-12",
        },
      ],
      [],
    ]);
  });

  test("names a layer to the globe, and says how to picture it, where the globe can draw it", () => {
    const geocolor = { instrument: "ABI", provider: "gibs", layer: "GOES-East_ABI_GeoColor", label: "GeoColor", kind: "rgb", period: "PT10M", window: "P90D" };
    const imagery = [
      { ...geocolor, maxLevel: 7, format: "png" },
      { ...geocolor, layer: "Linked" },
      { ...geocolor, layer: "Ended", maxLevel: 7, format: "jpeg", period: "P1D", end: "2026-11-02" },
    ];
    const [abi] = getSatelliteInfo(ISS, "LEO", { instruments: [{ name: "ABI" }], imagery }).instruments;

    expect(abi!.imagery.map((entry) => entry.token)).toEqual(["gibs:GOES-East_ABI_GeoColor", undefined, "gibs:Ended"]);
    expect(abi!.imagery.map((entry) => entry.preview)).toEqual([
      { provider: "gibs", layer: "GOES-East_ABI_GeoColor", format: "png", daily: false },
      undefined,
      { provider: "gibs", layer: "Ended", format: "jpeg", daily: true, end: "2026-11-02" },
    ]);
  });

  // SatelliteDetailsTests.swift holds the native app to the same.
  test("reads malformed imagery as the native app does, leaving out what is not of its type", () => {
    const malformed = [
      "MODIS",
      { instrument: "MODIS", provider: "gibs", layer: "a" },
      { instrument: "MODIS", provider: "gibs", layer: 7, label: "A" },
      { instrument: "MODIS", provider: "toString", layer: "a", label: "A" },
      { instrument: "MODIS", provider: "gibs", layer: "a", label: "A", period: 1, start: 2018, end: null, window: ["P90D"], merged: "yes" },
    ];
    const [modis] = getSatelliteInfo(ISS, "LEO", { instruments: [{ name: "MODIS" }], imagery: malformed as never }).instruments;

    expect(modis!.imagery).toEqual([{ label: "A", viewer: "NASA Worldview", href: "https://worldview.earthdata.nasa.gov/?l=a" }]);
    expect(getSatelliteInfo(ISS, "LEO", { instruments: [{ name: "MODIS" }], imagery: "gibs" as never }).instruments[0]!.imagery).toEqual([]);
  });

  test("omits every row the record does not carry, rather than showing defaults", () => {
    // The renderer still draws a DEFAULT_SWATH_KM swath and a DEFAULT_CONE_FOV_DEG cone.
    expect(labels(getSatelliteInfo(ISS, "LEO", {}))).not.toContain("Swath");
    expect(labels(getSatelliteInfo(ISS, "LEO", {}))).not.toContain("Sensor FOV");
  });

  test("shows a symmetric swath as a single total", () => {
    const rows = getSatelliteInfo(ISS, "LEO", { swathStarboardKm: 1175, swathPortKm: 1175 });
    expect(valueOf(rows, "Swath")).toBe("2,350 km");
  });

  test("spells out the sides when they differ", () => {
    const rows = getSatelliteInfo(ISS, "LEO", { swathStarboardKm: 1000, swathPortKm: 500 });
    expect(valueOf(rows, "Swath")).toBe("1,500 km (1,000 stbd / 500 port)");
  });

  test("includes the display-only fields when present", () => {
    const rows = getSatelliteInfo(ISS, "LEO", { coneFovDeg: 45, operator: "ESA", missionType: "Earth observation" });
    expect(valueOf(rows, "Sensor FOV")).toBe("45°");
    expect(valueOf(rows, "Operator")).toBe("ESA");
    expect(valueOf(rows, "Mission")).toBe("Earth observation");
  });

  describe("GCAT fields", () => {
    // The ISS's own GCAT values; the worker has already named the codes.
    const ISS_GCAT = {
      country: "USA",
      operator: "NASA Johnson Space Flight Center",
      manufacturer: "Khrunichev State Research and Production Center",
      bus: "77KS",
      massKg: 20281,
      lengthM: 12.6,
      diameterM: 4.2,
      spanM: 23.9,
      estimated: ["diameterM"],
    };

    test("shows who is responsible for it, who runs it and who built it", () => {
      const rows = getSatelliteInfo(ISS, "LEO", ISS_GCAT);
      expect(valueOf(rows, "Country")).toBe("USA");
      expect(valueOf(rows, "Operator")).toBe("NASA Johnson Space Flight Center");
      expect(valueOf(rows, "Manufacturer")).toBe("Khrunichev State Research and Production Center");
      expect(valueOf(rows, "Bus")).toBe("77KS");
    });

    test("labels the purpose and owner type, keeping what GCAT marks uncertain", () => {
      const rows = getSatelliteInfo(ISS, "LEO", { category: "IMG/TECH?", class: "BD" });
      expect(valueOf(rows, "Purpose")).toBe("Imaging / Technology?");
      expect(valueOf(rows, "Class")).toBe("Commercial / Military");
      // A code the table lacks shows as itself.
      expect(valueOf(getSatelliteInfo(ISS, "LEO", { category: "NEW*" }), "Purpose")).toBe("NEW");
      expect(valueOf(getSatelliteInfo(ISS, "LEO", { category: "SIG?*" }), "Purpose")).toBe("Signals intelligence?");
    });

    test("shows mass and size, marking GCAT's estimates", () => {
      const rows = getSatelliteInfo(ISS, "LEO", ISS_GCAT);
      expect(valueOf(rows, "Mass")).toBe("20,281 kg");
      expect(valueOf(rows, "Size")).toBe("12.6 × ~4.2 m, span 23.9 m");
    });

    test("builds the size row from whatever dimensions there are", () => {
      expect(valueOf(getSatelliteInfo(ISS, "LEO", { spanM: 29, estimated: ["spanM"] }), "Size")).toBe("span ~29 m");
      expect(valueOf(getSatelliteInfo(ISS, "LEO", { lengthM: 0.3 }), "Size")).toBe("0.3 m");
      expect(labels(getSatelliteInfo(ISS, "LEO", { country: "USA" }))).not.toContain("Size");
    });
  });

  describe("SATCAT fields", () => {
    test("resolves launch and status codes to labels", () => {
      const rows = getSatelliteInfo(ISS, "LEO", { launchDate: "1998-11-20", launchSite: "TYMSC", opsStatus: "+" });
      expect(valueOf(rows, "Launched")).toBe("1998-11-20 · Baikonur, Kazakhstan");
      expect(valueOf(rows, "Status")).toBe("Operational");
    });

    test("falls back to the raw code for one it does not know", () => {
      // The code tables lag new SATCAT codes; a code beats a blank.
      const rows = getSatelliteInfo(ISS, "LEO", { launchDate: "2026-01-01", launchSite: "QQQ", opsStatus: "!" });
      expect(valueOf(rows, "Launched")).toBe("2026-01-01 · QQQ");
      expect(valueOf(rows, "Status")).toBe("!");
    });

    test("shows the launch date alone when the site is missing", () => {
      expect(valueOf(getSatelliteInfo(ISS, "LEO", { launchDate: "1998-11-20" }), "Launched")).toBe("1998-11-20");
    });

    test("suppresses the ordinary orbit type but names the interesting ones", () => {
      expect(labels(getSatelliteInfo(ISS, "LEO", { orbitType: "ORB" }))).not.toContain("Orbit type");
      expect(valueOf(getSatelliteInfo(ISS, "LEO", { orbitType: "DOC" }), "Orbit type")).toBe("Docked");
      expect(valueOf(getSatelliteInfo(ISS, "LEO", { orbitType: "IMP" }), "Orbit type")).toBe("Impacted");
    });

    test("reports a decay date only once there is one", () => {
      expect(labels(getSatelliteInfo(ISS, "LEO", { opsStatus: "+" }))).not.toContain("Decayed");
      expect(valueOf(getSatelliteInfo(ISS, "LEO", { decayDate: "2026-08-03" }), "Decayed")).toBe("2026-08-03");
    });

    test("adds nothing for a satellite the catalog said nothing about", () => {
      expect(labels(getSatelliteInfo(ISS, "MEO", {}))).toEqual(["Orbit", "Apogee / Perigee"]);
      expect(valueOf(getSatelliteInfo(ISS, "MEO", {}), "Orbit")).toBe("MEO");
    });
  });
});
