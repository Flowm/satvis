import { describe, expect, test } from "vitest";

import Orbit from "../Orbit";
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

function labels({ rows }: SatelliteInfo): string[] {
  return rows.map(([label]) => label);
}

function valueOf({ rows }: SatelliteInfo, label: string): string | undefined {
  return rows.find(([rowLabel]) => rowLabel === label)?.[1];
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
    expect(staleElementsNotice(epochMs, epochMs + 30.4 * DAY_MS)).toBe("Position may be inaccurate, clock 30 days after element epoch");
    expect(staleElementsNotice(epochMs, epochMs - 15 * DAY_MS)).toBe("Position may be inaccurate, clock 15 days before element epoch");
  });
});

describe("getSatelliteInfo", () => {
  // 6786907: the chips asked for an "Owner" row that GCAT's Country had replaced.
  test("heads the panel with the orbit, the country and the status, from the facts themselves", () => {
    const info = getSatelliteInfo(ISS, "LEO", { country: "USA", opsStatus: "+", operator: "NASA" });
    expect(info.orbitClass).toBe("LEO");
    expect(info.chips).toEqual(["LEO", "USA", "Operational"]);
  });

  test("leaves out a chip the record has nothing for", () => {
    expect(getSatelliteInfo(ISS, "MEO", {}).chips).toEqual(["MEO"]);
  });

  test("reports the derived rows even with no metadata, class first", () => {
    expect(labels(getSatelliteInfo(ISS, "LEO", {}))).toEqual(["Orbit", "Apogee / Perigee"]);
    expect(valueOf(getSatelliteInfo(ISS, "LEO", {}), "Orbit")).toBe("LEO");
  });

  test("omits every row the record does not carry, rather than showing defaults", () => {
    // The renderer still draws a DEFAULT_SWATH_KM swath and a DEFAULT_CONE_FOV_DEG cone.
    expect(labels(getSatelliteInfo(ISS, "LEO", {}))).not.toContain("Swath");
    expect(labels(getSatelliteInfo(ISS, "LEO", {}))).not.toContain("Sensor FOV");
  });

  test("shows a symmetric swath as a single total", () => {
    const rows = getSatelliteInfo(ISS, "LEO", { swathStarboardKm: 1175, swathPortKm: 1175 });
    expect(valueOf(rows, "Swath")).toBe("2350 km");
  });

  test("spells out the sides when they differ", () => {
    const rows = getSatelliteInfo(ISS, "LEO", { swathStarboardKm: 1000, swathPortKm: 500 });
    expect(valueOf(rows, "Swath")).toBe("1500 km (1000 stbd / 500 port)");
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
