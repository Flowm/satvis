import dayjs from "dayjs";
import * as satellitejs from "satellite.js";
import { describe, expect, test } from "vitest";

import Orbit from "./Orbit";
import { parseGpPayload, type GpRecord } from "./util/gp";

const TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

// Physical invariants — orbital radius, altitude band, a non-empty pass list —
// rather than exact decimals: the values SGP4 produces for a given element set
// shift between satellite.js releases, so pinned decimals fail on upgrade
// without anything being wrong.
describe("Orbit (TLE record)", () => {
  const orbit = new Orbit("ISS", parseGpPayload(TLE)[0] as GpRecord);

  test("calculates a plausible satellite position", () => {
    const time = dayjs("2018-12-01").toDate();

    const positionECI = orbit.positionECI(time);
    expect(positionECI).not.toBeNull();
    // ISS orbital radius is ~6780 km (LEO).
    const radius = Math.sqrt(positionECI!.x ** 2 + positionECI!.y ** 2 + positionECI!.z ** 2);
    expect(radius).toBeGreaterThan(6600);
    expect(radius).toBeLessThan(6900);

    const positionGeodetic = orbit.positionGeodetic(time);
    expect(positionGeodetic).not.toBeNull();
    // ISS altitude is ~400 km (± band).
    expect(positionGeodetic!.height / 1000).toBeGreaterThan(380);
    expect(positionGeodetic!.height / 1000).toBeLessThan(430);
  });

  test("calculates passes", () => {
    const gs = { latitude: 48.177, longitude: 11.7476, height: 0 };
    const start = dayjs("2018-12-08");
    const end = dayjs("2018-12-22");

    const passes = orbit.computePassesElevation(gs, start.toDate(), end.toDate(), 1, 500);
    // Roughly one visible pass per ~1.5 orbits over Munich across two weeks.
    expect(passes.length).toBeGreaterThan(50);
  });

  test("exposes tle lines and satnum", () => {
    expect(orbit.tle).toHaveLength(3);
    expect(orbit.satnum).toBe("25544");
  });
});

// lastElevation starts without a real previous sample, and a pass still open
// when the window ends is a different edge of the same problem: the scan's
// first and last samples both need to behave like real data, not like the
// absence of it.
describe("Orbit elevation pass window edges", () => {
  const orbit = new Orbit("ISS", parseGpPayload(TLE)[0] as GpRecord);
  const gs = { latitude: 48.177, longitude: 11.7476, height: 0 };

  test("a pass whose AOS is seconds after the window opens, with the satellite still below the horizon, is not skipped", () => {
    // 2018-12-09T10:56:49Z is a real AOS over this station for this TLE
    // (found once via a fine-grained scan); 10:55:12Z is ~90s earlier, where
    // true elevation is already negative but rising toward it. A lastElevation
    // initialised to 0 reads that first sample as declining (elevation < 0)
    // and jumps half an orbit ahead, skipping the pass entirely.
    const windowStart = dayjs("2018-12-09T10:55:12Z").toDate();
    const windowEnd = dayjs("2018-12-09T11:05:00Z").toDate();
    const passes = orbit.computePassesElevation(gs, windowStart, windowEnd, 5, 500);
    expect(passes).toHaveLength(1);
    expect(passes[0]!.start).toBeGreaterThanOrEqual(windowStart.getTime());
    // AOS should land within a few seconds of the true crossing, not be
    // missing nor artificially pinned to the window's own start.
    expect(Math.abs(passes[0]!.start - dayjs("2018-12-09T10:56:49Z").valueOf())).toBeLessThan(5000);
  });

  test("a pass still above the horizon when the window ends is reported truncated, not dropped", () => {
    // 2018-12-08T11:48:01Z–11:55:01Z is a real pass over this station for
    // this TLE; cutting the window in the middle of it used to lose it
    // entirely rather than reporting the truncated pass the loop already
    // does when a window instead opens mid-pass.
    const windowStart = dayjs("2018-12-08T11:40:00Z").toDate();
    const windowEnd = dayjs("2018-12-08T11:51:30Z").toDate();
    const passes = orbit.computePassesElevation(gs, windowStart, windowEnd, 5, 500);
    expect(passes).toHaveLength(1);
    expect(Math.abs(passes[0]!.start - dayjs("2018-12-08T11:48:01Z").valueOf())).toBeLessThan(5000);
    expect(passes[0]!.end).toBe(windowEnd.getTime());
    expect(passes[0]!.duration).toBe(passes[0]!.end - passes[0]!.start);
  });

  // The real pass this block uses throughout: 2018-12-08T11:48:01Z–11:55:01Z,
  // azimuthEnd 81.29° at its natural LOS, found once via a wide scan. The next
  // one after it, for the first-sample sentinel case below, is
  // 13:23:27Z–13:31:47Z.

  test("AOS exactly at the window's own start is reported there, not missed or misdated", () => {
    const windowStart = dayjs("2018-12-08T11:48:01Z").toDate();
    const windowEnd = dayjs("2018-12-08T12:00:00Z").toDate();
    const passes = orbit.computePassesElevation(gs, windowStart, windowEnd, 5, 500);
    expect(passes).toHaveLength(1);
    expect(passes[0]!.start).toBe(windowStart.getTime());
    expect(passes[0]!.end).toBeLessThan(windowEnd.getTime());
  });

  test("a pass already above the horizon at the window's start is truncated there, not given a false AOS", () => {
    const windowStart = dayjs("2018-12-08T11:50:00Z").toDate();
    const windowEnd = dayjs("2018-12-08T12:00:00Z").toDate();
    const passes = orbit.computePassesElevation(gs, windowStart, windowEnd, 5, 500);
    expect(passes).toHaveLength(1);
    expect(passes[0]!.start).toBe(windowStart.getTime());
    expect(Math.abs(passes[0]!.end - dayjs("2018-12-08T11:55:01Z").valueOf())).toBeLessThan(5000);
  });

  test("a pass spanning the entire window is reported bounded by the window on both ends", () => {
    const windowStart = dayjs("2018-12-08T11:49:00Z").toDate();
    const windowEnd = dayjs("2018-12-08T11:54:00Z").toDate();
    const passes = orbit.computePassesElevation(gs, windowStart, windowEnd, 5, 500);
    expect(passes).toHaveLength(1);
    expect(passes[0]!.start).toBe(windowStart.getTime());
    expect(passes[0]!.end).toBe(windowEnd.getTime());
    expect(passes[0]!.duration).toBe(windowEnd.getTime() - windowStart.getTime());
  });

  test("a natural LOS landing on the loop's final iteration is reported once, not duplicated by the end-of-window truncation", () => {
    // Window end is comfortably after the true LOS (11:55:01Z), so the loop's
    // own exit branch — not the post-loop truncation — is what records this
    // pass. ongoingPass must already be false by the time the loop ends, or
    // the truncation would push a second, spurious entry for the same pass.
    const windowStart = dayjs("2018-12-08T11:48:01Z").toDate();
    const windowEnd = dayjs("2018-12-08T11:56:00Z").toDate();
    const passes = orbit.computePassesElevation(gs, windowStart, windowEnd, 5, 500);
    expect(passes).toHaveLength(1);
    expect(passes[0]!.end).toBeLessThan(windowEnd.getTime());
    expect(passes[0]!.end).toBeGreaterThan(passes[0]!.start);
  });

  test("a window cut moments after AOS reports a short but strictly positive duration, never zero or negative", () => {
    const windowStart = dayjs("2018-12-08T11:48:01Z").toDate();
    const windowEnd = dayjs("2018-12-08T11:48:03Z").toDate();
    const passes = orbit.computePassesElevation(gs, windowStart, windowEnd, 5, 500);
    expect(passes).toHaveLength(1);
    expect(passes[0]!.start).toBe(windowStart.getTime());
    expect(passes[0]!.end).toBe(windowEnd.getTime());
    expect(passes[0]!.duration).toBeGreaterThan(0);
  });

  test("a truncated pass's azimuthEnd is the true azimuth at the window's own end, not the apex carried forward", () => {
    const windowStart = dayjs("2018-12-08T11:48:01Z").toDate();
    const windowEnd = dayjs("2018-12-08T11:50:00Z").toDate();
    const passes = orbit.computePassesElevation(gs, windowStart, windowEnd, 5, 500);
    expect(passes).toHaveLength(1);
    expect(passes[0]!.azimuthEnd).not.toBe(passes[0]!.azimuthApex);

    // Independently computed via the same primitives computePassesElevation
    // itself uses, rather than re-asserting whatever the implementation did.
    const groundStation = { latitude: gs.latitude * (Math.PI / 180), longitude: gs.longitude * (Math.PI / 180), height: gs.height / 1000 };
    const positionEcf = orbit.positionECF(windowEnd)!;
    const expectedAzimuthDeg = satellitejs.ecfToLookAngles(groundStation, positionEcf).azimuth * (180 / Math.PI);
    expect(passes[0]!.azimuthEnd).toBeCloseTo(expectedAzimuthDeg, 3);
  });

  test("the first-sample sentinel does not suppress a legitimate coarse skip once a real previous sample exists", () => {
    // Window opens 9 seconds after the known pass's true LOS (11:55:01Z), so
    // elevation here is genuinely declining from the very first sample — the
    // sentinel only changes how THAT one sample is classified, and must not
    // stop the second sample onward from correctly recognising the decline
    // and skipping ahead to the next real pass (13:23:27Z–13:31:47Z) rather
    // than fine-stepping the whole gap between them.
    const windowStart = dayjs("2018-12-08T11:55:10Z").toDate();
    const windowEnd = dayjs("2018-12-08T14:00:00Z").toDate();
    const passes = orbit.computePassesElevation(gs, windowStart, windowEnd, 5, 500);
    expect(passes).toHaveLength(1);
    expect(Math.abs(passes[0]!.start - dayjs("2018-12-08T13:23:27Z").valueOf())).toBeLessThan(5000);
    expect(Math.abs(passes[0]!.end - dayjs("2018-12-08T13:31:47Z").valueOf())).toBeLessThan(5000);
  });
});

// Swath containment is tested against ground stations placed at a known offset
// from the ground track, so the assertions are about geometry rather than about
// whichever passes SGP4 happens to produce over a real city.
describe("Orbit swath containment", () => {
  const orbit = new Orbit("ISS", parseGpPayload(TLE)[0] as GpRecord);
  const EARTH_RADIUS_KM = 6371;
  const deg2rad = Math.PI / 180;
  const rad2deg = 180 / Math.PI;
  const AT = dayjs("2018-12-08T12:00:00Z").toDate();

  /** Destination point `distanceKm` from (lat, lon) along `bearingRad`, in degrees. */
  function destination(latDeg: number, lonDeg: number, bearingRad: number, distanceKm: number) {
    const lat = latDeg * deg2rad;
    const lon = lonDeg * deg2rad;
    const delta = distanceKm / EARTH_RADIUS_KM;
    const lat2 = Math.asin(Math.sin(lat) * Math.cos(delta) + Math.cos(lat) * Math.sin(delta) * Math.cos(bearingRad));
    const lon2 = lon + Math.atan2(Math.sin(bearingRad) * Math.sin(delta) * Math.cos(lat), Math.cos(delta) - Math.sin(lat) * Math.sin(lat2));
    return { latitude: lat2 * rad2deg, longitude: lon2 * rad2deg, height: 0 };
  }

  /** The satellite's flight bearing (radians) at AT, from two subpoints. */
  function flightBearing(): number {
    const here = orbit.positionGeodetic(AT)!;
    const ahead = orbit.positionGeodetic(new Date(AT.getTime() + 10_000))!;
    const lat1 = here.latitude * deg2rad;
    const lon1 = here.longitude * deg2rad;
    const lat2 = ahead.latitude * deg2rad;
    const lon2 = ahead.longitude * deg2rad;
    const deltaLon = lon2 - lon1;
    return Math.atan2(Math.sin(deltaLon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon));
  }

  /** Ground stations 400 km to starboard and to port of the track at AT. */
  function flankingStations(offsetKm = 400) {
    const here = orbit.positionGeodetic(AT)!;
    const bearing = flightBearing();
    return {
      starboard: destination(here.latitude, here.longitude, bearing + Math.PI / 2, offsetKm),
      port: destination(here.latitude, here.longitude, bearing - Math.PI / 2, offsetKm),
    };
  }

  test("names the side a station lies on", () => {
    const { starboard, port } = flankingStations();
    expect(orbit.trackOffsets(starboard, AT)!.side).toBe("starboard");
    expect(orbit.trackOffsets(port, AT)!.side).toBe("port");
  });

  test("reports the great-circle distance to the subpoint", () => {
    const { starboard, port } = flankingStations();
    expect(orbit.trackOffsets(starboard, AT)!.distanceKm).toBeCloseTo(400, 0);
    expect(orbit.trackOffsets(port, AT)!.distanceKm).toBeCloseTo(400, 0);
  });

  test("bounds a station straight ahead by distance, so it is not served", () => {
    // A per-side test keyed on cross-track offset alone would place this station at
    // zero offset and serve it for the whole orbit; distance bounds it.
    const here = orbit.positionGeodetic(AT)!;
    const ahead = destination(here.latitude, here.longitude, flightBearing(), 1200);
    expect(orbit.trackOffsets(ahead, AT)!.distanceKm).toBeCloseTo(1200, -1);
    expect(orbit.computePassesSwath(ahead, { starboardKm: 600, portKm: 600 }, AT, new Date(AT.getTime() + 60_000))).toHaveLength(0);
  });

  test("an asymmetric swath serves the wide side and not the narrow one", () => {
    const { starboard, port } = flankingStations();
    // 400 km off-track: inside a 600 km starboard extent, outside a 200 km port one.
    const swath = { starboardKm: 600, portKm: 200 };
    const start = AT;
    const end = new Date(AT.getTime() + 30 * 60_000);

    expect(orbit.computePassesSwath(starboard, swath, start, end).length).toBeGreaterThan(0);
    expect(orbit.computePassesSwath(port, swath, start, end)).toHaveLength(0);

    // Mirroring the extents flips which station is served — the sides are not
    // interchangeable, which a single total width could never express.
    const mirrored = { starboardKm: 200, portKm: 600 };
    expect(orbit.computePassesSwath(starboard, mirrored, start, end)).toHaveLength(0);
    expect(orbit.computePassesSwath(port, mirrored, start, end).length).toBeGreaterThan(0);
  });

  test("a symmetric swath is the plain distance test the old single-width model used", () => {
    // Pins the ADR-0002 claim that symmetric satellites keep their windows exactly:
    // containment must be `distance <= total / 2`, side-independent.
    const { starboard, port } = flankingStations(400);
    const start = AT;
    const end = new Date(AT.getTime() + 30 * 60_000);
    for (const station of [starboard, port]) {
      // 400 km out: served by a 401 km side extent, not by a 399 km one.
      expect(orbit.computePassesSwath(station, { starboardKm: 401, portKm: 401 }, start, end).length).toBeGreaterThan(0);
      expect(orbit.computePassesSwath(station, { starboardKm: 399, portKm: 399 }, start, end)).toHaveLength(0);
    }
  });

  test("a symmetric swath serves both sides alike", () => {
    const { starboard, port } = flankingStations();
    const swath = { starboardKm: 600, portKm: 600 };
    const start = AT;
    const end = new Date(AT.getTime() + 30 * 60_000);
    expect(orbit.computePassesSwath(starboard, swath, start, end).length).toBeGreaterThan(0);
    expect(orbit.computePassesSwath(port, swath, start, end).length).toBeGreaterThan(0);
  });

  test("reports the total width on the pass, for display", () => {
    const { starboard } = flankingStations();
    const passes = orbit.computePassesSwath(starboard, { starboardKm: 600, portKm: 200 }, AT, new Date(AT.getTime() + 30 * 60_000));
    expect(passes[0]!.swathWidth).toBe(800);
  });

  // Closest approach 25 s after AT, off the round-minute grid a coarse scan steps on.
  const CLOSEST = new Date(AT.getTime() + 25_000);

  function stationAbeam(offsetKm: number) {
    const here = orbit.positionGeodetic(CLOSEST)!;
    return destination(here.latitude, here.longitude, flightBearing() + Math.PI / 2, offsetKm);
  }

  function passesAround(offsetKm: number, swath: { starboardKm: number; portKm: number }, beforeMin = 10, afterMin = 10) {
    return orbit.computePassesSwath(stationAbeam(offsetKm), swath, new Date(AT.getTime() - beforeMin * 60_000), new Date(AT.getTime() + afterMin * 60_000));
  }

  test.each([
    [10, 30],
    [0.5, 1],
    [28.5, 30],
  ])("finds a pass %s km off a %s km extent that lasts only seconds", (offsetKm, extentKm) => {
    const passes = passesAround(offsetKm, { starboardKm: extentKm, portKm: extentKm });
    expect(passes).toHaveLength(1);
    expect(passes[0]!.minDistance).toBeCloseTo(offsetKm, 0);
    expect(passes[0]!.minDistanceTime).toBeCloseTo(CLOSEST.getTime(), -3);
  });

  test.each([100, 1450])("reports the closest approach, not the edge, on a %s km extent", (extentKm) => {
    const passes = passesAround(50, { starboardKm: extentKm, portKm: extentKm }, 20, 20);
    expect(passes).toHaveLength(1);
    expect(passes[0]!.minDistance).toBeCloseTo(50, 0);
  });

  test("finds the narrow side's pass of an asymmetric swath", () => {
    const passes = passesAround(2.5, { starboardKm: 5, portKm: 100 });
    expect(passes).toHaveLength(1);
    expect(passes[0]!.minDistance).toBeLessThanOrEqual(5);
  });

  test("truncates a pass still open when the window ends", () => {
    const passes = orbit.computePassesSwath(stationAbeam(5), { starboardKm: 10, portKm: 10 }, new Date(AT.getTime() - 10 * 60_000), CLOSEST);
    expect(passes).toHaveLength(1);
    expect(passes[0]!.end).toBe(CLOSEST.getTime());
    expect(passes[0]!.duration).toBeGreaterThan(0);
  });

  test("stops at maxPasses", () => {
    const passes = orbit.computePassesSwath(stationAbeam(50), { starboardKm: 1450, portKm: 1450 }, AT, new Date(AT.getTime() + 2 * 86_400_000), 2);
    expect(passes).toHaveLength(2);
  });
});

describe("Orbit (GpRecord path)", () => {
  test("OMM record builds an orbit without tle lines", () => {
    const omm = JSON.stringify([
      {
        OBJECT_NAME: "ISS (ZARYA)",
        OBJECT_ID: "1998-067A",
        EPOCH: "2026-07-04T02:07:57.020160",
        MEAN_MOTION: 15.48879284,
        ECCENTRICITY: 0.00067632,
        INCLINATION: 51.6303,
        RA_OF_ASC_NODE: 216.4301,
        ARG_OF_PERICENTER: 253.0749,
        MEAN_ANOMALY: 106.9498,
        NORAD_CAT_ID: 25544,
        ELEMENT_SET_NO: 999,
        BSTAR: 0.00014587488,
        MEAN_MOTION_DOT: 7.564e-5,
        MEAN_MOTION_DDOT: 0,
      },
    ]);
    const record = parseGpPayload(omm)[0] as GpRecord;
    const orbit = new Orbit("ISS", record);
    expect(orbit.satnum).toBe("25544");
    expect(orbit.tle).toBeUndefined();
    expect(orbit.record.kind).toBe("omm");
    expect(orbit.error).toBe(0);
  });
});
