import { describe, expect, test } from "vitest";

import Orbit from "../Orbit";
import { formatEpoch, getSatelliteInfo } from "./entityInfo";
import { parseGpPayload, type GpRecord } from "./gp";

// Not sun-synchronous, so the only derived row after the class is the apsides.
// orbitFacts.test.ts covers the derivation.
const ISS = new Orbit(
  "ISS (ZARYA)",
  parseGpPayload(
    "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658",
  )[0] as GpRecord,
);

function labels(rows: [string, string][]): string[] {
  return rows.map(([label]) => label);
}

function valueOf(rows: [string, string][], label: string): string | undefined {
  return rows.find(([rowLabel]) => rowLabel === label)?.[1];
}

describe("formatEpoch", () => {
  test("formats a julian date as UTC timestamp", () => {
    // JD 2460000.5 == 2023-02-25T00:00:00Z
    expect(formatEpoch(2460000.5)).toBe("2023-02-25 00:00:00");
  });
});

describe("getSatelliteInfo", () => {
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

  describe("SATCAT fields", () => {
    test("resolves owner, launch and status codes to labels", () => {
      const rows = getSatelliteInfo(ISS, "LEO", { owner: "ISS", launchDate: "1998-11-20", launchSite: "TYMSC", opsStatus: "+" });
      expect(valueOf(rows, "Owner")).toBe("International Space Station");
      expect(valueOf(rows, "Launched")).toBe("1998-11-20 · Baikonur, Kazakhstan");
      expect(valueOf(rows, "Status")).toBe("Operational");
    });

    test("falls back to the raw code for one it does not know", () => {
      // The code tables lag new SATCAT codes; a code beats a blank.
      const rows = getSatelliteInfo(ISS, "LEO", { owner: "ZZZ", launchDate: "2026-01-01", launchSite: "QQQ", opsStatus: "!" });
      expect(valueOf(rows, "Owner")).toBe("ZZZ");
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
