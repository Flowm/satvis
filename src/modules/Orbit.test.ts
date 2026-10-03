import dayjs from "dayjs";
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

  // The coarse ladder steps at up to 5 minutes while still outside the swath,
  // which can be wider than the whole window a narrow sensor serves a station
  // for — ~8 s for a 30 km extent here. Without the refinement step a pass
  // this narrow falls between two coarse samples and is never recorded at all.
  test("a narrow swath's pass is not skipped between two coarse steps", () => {
    // A phase deliberately not aligned with the coarse ladder's round-minute
    // steps, so the closest approach does not land on a step boundary by luck.
    const closest = new Date(AT.getTime() + 25_000);
    const here = orbit.positionGeodetic(closest)!;
    const bearing = flightBearing();
    const station = destination(here.latitude, here.longitude, bearing + Math.PI / 2, 10);
    const extentKm = 30;

    const start = new Date(AT.getTime() - 7 * 60_000);
    const end = new Date(AT.getTime() + 11 * 60_000);
    const passes = orbit.computePassesSwath(station, { starboardKm: extentKm, portKm: extentKm }, start, end);

    expect(passes).toHaveLength(1);
    expect(passes[0]!.minDistance).toBeLessThanOrEqual(extentKm);
    expect(passes[0]!.start).toBeGreaterThan(start.getTime());
    expect(passes[0]!.end).toBeLessThan(end.getTime());
  });

  // A kilometre-scale swath's whole catchment window can be under half a
  // second — far finer than the coarse ladder's steps, and finer than the
  // 2-second-step version of this fix was ever checked against. Proves the
  // numerical refinement resolves an event this narrow, not just one the
  // earlier fix happened to land a sample inside of.
  test("a 1 km swath's pass is detected, not just a tens-of-kilometres one", () => {
    const closest = new Date(AT.getTime() + 25_000);
    const here = orbit.positionGeodetic(closest)!;
    const bearing = flightBearing();
    const station = destination(here.latitude, here.longitude, bearing + Math.PI / 2, 0.5);

    const start = new Date(AT.getTime() - 7 * 60_000);
    const end = new Date(AT.getTime() + 11 * 60_000);
    const passes = orbit.computePassesSwath(station, { starboardKm: 1, portKm: 1 }, start, end);

    expect(passes).toHaveLength(1);
    expect(passes[0]!.minDistance).toBeLessThanOrEqual(1);
  });

  // minDistance sitting just inside the extent, rather than comfortably
  // inside it, is the case most likely to be lost to a search that converges
  // to the wrong side of a shallow dip.
  test("a near-edge pass (minimum distance just inside the extent) is detected", () => {
    const closest = new Date(AT.getTime() + 25_000);
    const here = orbit.positionGeodetic(closest)!;
    const bearing = flightBearing();
    const extentKm = 30;
    const station = destination(here.latitude, here.longitude, bearing + Math.PI / 2, extentKm * 0.95);

    const start = new Date(AT.getTime() - 7 * 60_000);
    const end = new Date(AT.getTime() + 11 * 60_000);
    const passes = orbit.computePassesSwath(station, { starboardKm: extentKm, portKm: extentKm }, start, end);

    expect(passes).toHaveLength(1);
    expect(passes[0]!.minDistance).toBeLessThanOrEqual(extentKm);
    expect(passes[0]!.minDistance).toBeGreaterThan(extentKm * 0.9);
  });

  // A conjunction can be hiding not only in the coarse approach ladder's own
  // step, but in the 30-second dwell step the "inside" branch uses to track
  // an ongoing pass — a grazing crossing can be in and out of even a wide
  // extent well inside thirty seconds. Both must be refined, not only the one
  // that first flagged this issue.
  test("a pass shorter than the inside dwell step still gets its true minimum, not the entry point", () => {
    const closest = new Date(AT.getTime() + 25_000);
    const here = orbit.positionGeodetic(closest)!;
    const bearing = flightBearing();
    const extentKm = 100;
    const station = destination(here.latitude, here.longitude, bearing + Math.PI / 2, 50);

    const start = new Date(AT.getTime() - 10 * 60_000);
    const end = new Date(AT.getTime() + 10 * 60_000);
    const passes = orbit.computePassesSwath(station, { starboardKm: extentKm, portKm: extentKm }, start, end);

    expect(passes).toHaveLength(1);
    // The true minimum is close to 50 km; a pass found only via its entry
    // crossing would instead report something close to the 100 km extent.
    expect(passes[0]!.minDistance).toBeLessThan(60);
  });

  // Mirrors the elevation-mode fix: a conjunction still open when the window
  // ends must be reported truncated, not silently dropped.
  test("a pass still open when the window ends is truncated, not dropped", () => {
    const closest = new Date(AT.getTime() + 25_000);
    const here = orbit.positionGeodetic(closest)!;
    const bearing = flightBearing();
    const extentKm = 10;
    const station = destination(here.latitude, here.longitude, bearing + Math.PI / 2, 5);

    const start = new Date(AT.getTime() - 10 * 60_000);
    const end = closest; // cuts the window right at the true closest approach
    const passes = orbit.computePassesSwath(station, { starboardKm: extentKm, portKm: extentKm }, start, end);

    expect(passes).toHaveLength(1);
    expect(passes[0]!.end).toBe(end.getTime());
    expect(passes[0]!.duration).toBeGreaterThan(0);
  });

  test("an asymmetric swath's narrow side still finds its pass alongside the wide side's", () => {
    const closest = new Date(AT.getTime() + 25_000);
    const bearing = flightBearing();
    const here = orbit.positionGeodetic(closest)!;
    const starboardStation = destination(here.latitude, here.longitude, bearing + Math.PI / 2, 2.5);

    const start = new Date(AT.getTime() - 7 * 60_000);
    const end = new Date(AT.getTime() + 11 * 60_000);
    const passes = orbit.computePassesSwath(starboardStation, { starboardKm: 5, portKm: 100 }, start, end);

    expect(passes).toHaveLength(1);
    expect(passes[0]!.minDistance).toBeLessThanOrEqual(5);
  });

  test("a wide swath's pass is still found (control)", () => {
    const { starboard } = flankingStations(300);
    const start = new Date(AT.getTime() - 5 * 60_000);
    const end = new Date(AT.getTime() + 5 * 60_000);
    const passes = orbit.computePassesSwath(starboard, { starboardKm: 600, portKm: 600 }, start, end);
    expect(passes.length).toBeGreaterThan(0);
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
