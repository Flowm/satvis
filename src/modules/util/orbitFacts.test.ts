// Real element sets checked against published mission values: a hand-built satrec
// would only prove the arithmetic against itself.

import { describe, expect, test } from "vitest";

import Orbit from "../Orbit";
import { parseGpPayload, type GpRecord } from "./gp";
import { derivedOrbitRows, isSunSynchronous, orbitRegimeLabel } from "./orbitFacts";

function orbitOf(tle: string): Orbit {
  return new Orbit(tle.split("\n")[0]!, parseGpPayload(tle)[0] as GpRecord);
}

function rowValue(orbit: Orbit, label: string): string | undefined {
  return derivedOrbitRows(orbit).find(([rowLabel]) => rowLabel === label)?.[1];
}

// Published descending node: 10:30 local mean solar time.
const SENTINEL_2A = orbitOf(
  "SENTINEL-2A\n1 40697U 15028A   26223.45944444  .00000123  00000-0  62329-4 0  9993\n2 40697  98.5663 297.5180 0001357  89.5010 270.6328 14.30818424580123",
);

const ISS = orbitOf("ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658");

const GOES = orbitOf("GOES 18\n1 51850U 22021A   26223.50000000 -.00000267  00000-0  00000-0 0  9990\n2 51850   0.0140 279.0000 0000500 200.0000 160.0000  1.00270000 16000");

describe("isSunSynchronous", () => {
  test("accepts a satellite designed for it", () => {
    expect(isSunSynchronous(SENTINEL_2A.satrec)).toBe(true);
  });

  test("rejects an inclination that turns the node the wrong way", () => {
    // Prograde nodal regression is negative and can never match the sun's +0.9856°/day.
    expect(isSunSynchronous(ISS.satrec)).toBe(false);
  });

  test("rejects a near-equatorial orbit", () => {
    expect(isSunSynchronous(GOES.satrec)).toBe(false);
  });
});

describe("orbitRegimeLabel", () => {
  test("appends the note rather than replacing the class", () => {
    expect(orbitRegimeLabel("LEO", SENTINEL_2A)).toBe("LEO · Sun-synchronous");
  });

  test("leaves a satellite that is not sun-synchronous alone", () => {
    expect(orbitRegimeLabel("LEO", ISS)).toBe("LEO");
    expect(orbitRegimeLabel("GEO", GOES)).toBe("GEO");
  });
});

describe("derivedOrbitRows", () => {
  test("quotes the apsides as one pair, in km of altitude", () => {
    const apsides = rowValue(ISS, "Apogee / Perigee");
    const [apogee, perigee] = apsides!.replace(" km", "").split(" / ").map(Number);
    expect(apogee).toBeGreaterThan(380);
    expect(apogee).toBeLessThan(460);
    expect(apogee! - perigee!).toBeLessThan(30);
    expect(apogee).toBeGreaterThanOrEqual(perigee!);
  });

  test("reports apsides for a satellite with no node times", () => {
    expect(rowValue(GOES, "Apogee / Perigee")).toMatch(/^3\d{4} \/ 3\d{4} km$/);
    expect(rowValue(GOES, "LTAN / LTDN")).toBeUndefined();
  });

  test("lands on the published node times for a sun-synchronous satellite", () => {
    // A few minutes' slack: the element set is the real orbit, not the design.
    const [ltan, ltdn] = rowValue(SENTINEL_2A, "LTAN / LTDN")!.split(" / ");
    expect(Math.abs(minutesOf(ltdn!) - (10 * 60 + 30))).toBeLessThanOrEqual(3);
    expect((minutesOf(ltan!) - minutesOf(ltdn!) + 1440) % 1440).toBe(12 * 60);
  });

  test("says nothing about the nodes of a drifting orbit", () => {
    expect(rowValue(ISS, "LTAN / LTDN")).toBeUndefined();
  });
});

function minutesOf(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours! * 60 + minutes!;
}
