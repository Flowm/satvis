import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { json2satrec, propagate, twoline2satrec, type OMMJsonObject } from "satellite.js";
import { describe, expect, test } from "vitest";

/**
 * ISS fixtures from CelesTrak (FORMAT=2LE and FORMAT=JSON): satrecs from both formats
 * must propagate to the same ECI position.
 */
const twoLe = readFileSync(fileURLToPath(new URL("./fixtures/iss.2le.txt", import.meta.url)), "utf8")
  .trim()
  .split(/\r?\n/);
const ommArray = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/iss.omm.json", import.meta.url)), "utf8")) as OMMJsonObject[];

const satrecTle = twoline2satrec(twoLe[0] as string, twoLe[1] as string);
const satrecOmm = json2satrec(ommArray[0] as OMMJsonObject);

/** satrec.jdsatepoch is a full Julian Date in satellite.js 7.x. */
function jdToDate(jd: number): Date {
  return new Date((jd - 2440587.5) * 86400000);
}

const epoch = jdToDate(satrecOmm.jdsatepoch);

function positionAt(minutesAfterEpoch: number): { tle: [number, number, number]; omm: [number, number, number] } {
  const time = new Date(epoch.getTime() + minutesAfterEpoch * 60000);
  const rTle = propagate(satrecTle, time);
  const rOmm = propagate(satrecOmm, time);
  if (!rTle || !rOmm) {
    throw new Error("propagation failed");
  }
  return {
    tle: [rTle.position.x, rTle.position.y, rTle.position.z],
    omm: [rOmm.position.x, rOmm.position.y, rOmm.position.z],
  };
}

describe("TLE vs OMM satrec equivalence (ISS)", () => {
  test("both satrecs build without error", () => {
    expect(satrecTle.error).toBe(0);
    expect(satrecOmm.error).toBe(0);
  });

  test.each([
    ["epoch", 0],
    ["+45min", 45],
    ["+24h", 24 * 60],
  ])("ECI position matches within 1 km at %s", (_label, minutes) => {
    const { tle, omm } = positionAt(minutes as number);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(Math.abs((tle[axis] as number) - (omm[axis] as number))).toBeLessThan(1);
    }
  });
});
