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

describe("Orbit elevation passes", () => {
  const orbit = new Orbit("ISS", parseGpPayload(TLE)[0] as GpRecord);
  const gs = { latitude: 48.177, longitude: 11.7476, height: 0 };
  const at = (iso: string) => dayjs(iso).toDate();

  /** Passes above 5° by brute force, truncated at the window, to `stepMs`. */
  function scan(o: Orbit, start: Date, end: Date, stepMs: number) {
    const station = { latitude: gs.latitude * (Math.PI / 180), longitude: gs.longitude * (Math.PI / 180), height: 0 };
    const isAbove = (t: number) => {
      const ecf = o.positionECF(new Date(t));
      return ecf !== null && satellitejs.ecfToLookAngles(station, ecf).elevation * (180 / Math.PI) > 5;
    };
    const passes: { start: number; end: number }[] = [];
    let rise: number | undefined;
    for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
      const above = isAbove(t);
      if (above && rise === undefined) {
        rise = t;
      } else if (!above && rise !== undefined) {
        passes.push({ start: rise, end: t });
        rise = undefined;
      }
    }
    if (rise !== undefined) {
      passes.push({ start: rise, end: end.getTime() });
    }
    return passes;
  }

  test.each([
    ["rising just after the window opens", "2018-12-09T10:55:12Z", "2018-12-09T11:05:00Z"],
    ["after one that set just before the window", "2018-12-08T11:55:10Z", "2018-12-08T14:00:00Z"],
    ["already up when the window opens", "2018-12-08T11:50:00Z", "2018-12-08T12:00:00Z"],
    ["still up when the window ends", "2018-12-08T11:40:00Z", "2018-12-08T11:51:30Z"],
    ["up for the whole window", "2018-12-08T11:49:00Z", "2018-12-08T11:54:00Z"],
  ])("finds a pass %s, edges to the window", (_, from, to) => {
    const [want] = scan(orbit, at(from), at(to), 100);
    const passes = orbit.computePassesElevation(gs, at(from), at(to));
    expect(passes).toHaveLength(1);
    expect(Math.abs(passes[0]!.start - want!.start)).toBeLessThanOrEqual(100);
    expect(Math.abs(passes[0]!.end - want!.end)).toBeLessThanOrEqual(100);
    expect(passes[0]!.duration).toBe(passes[0]!.end - passes[0]!.start);
    expect(passes[0]!.apex).toBeGreaterThanOrEqual(passes[0]!.start);
    expect(passes[0]!.apex).toBeLessThanOrEqual(passes[0]!.end);
  });

  test("gives a truncated pass the azimuth at the window's end", () => {
    const end = at("2018-12-08T11:50:00Z");
    const [pass] = orbit.computePassesElevation(gs, at("2018-12-08T11:40:00Z"), end);
    const station = { latitude: gs.latitude * (Math.PI / 180), longitude: gs.longitude * (Math.PI / 180), height: 0 };
    const azimuth = satellitejs.ecfToLookAngles(station, orbit.positionECF(end)!).azimuth * (180 / Math.PI);
    expect(pass!.azimuthEnd).toBeCloseTo(azimuth, 3);
  });

  test("stops at maxPasses without repeating the last one", () => {
    const passes = orbit.computePassesElevation(gs, at("2018-12-08T00:00:00Z"), at("2018-12-10T00:00:00Z"), 5, 2);
    expect(passes).toHaveLength(2);
    expect(passes[1]!.start).toBeGreaterThan(passes[0]!.end);
    for (const pass of passes) {
      expect(pass.azimuthStart).toBeLessThanOrEqual(360);
    }
  });

  test("agrees with a brute-force scan for an eccentric orbit that sets and rises again within reach", () => {
    const omm = JSON.stringify([
      {
        OBJECT_NAME: "MOLNIYA",
        OBJECT_ID: "2000-005A",
        EPOCH: "2026-07-04T00:00:00.000",
        MEAN_MOTION: 2.006,
        ECCENTRICITY: 0.72,
        INCLINATION: 63.4,
        RA_OF_ASC_NODE: 100,
        ARG_OF_PERICENTER: 270,
        MEAN_ANOMALY: 0,
        NORAD_CAT_ID: 90005,
        ELEMENT_SET_NO: 999,
        BSTAR: 0,
        MEAN_MOTION_DDOT: 0,
        MEAN_MOTION_DOT: 0,
      },
    ]);
    const molniya = new Orbit("MOLNIYA", parseGpPayload(omm)[0] as GpRecord);
    const start = at("2026-07-04T00:00:00Z");
    const end = at("2026-07-07T00:00:00Z");
    const passes = molniya.computePassesElevation(gs, start, end);
    expect(passes.length).toBe(scan(molniya, start, end, 10_000).length);
    expect(passes.length).toBeGreaterThan(3);
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
