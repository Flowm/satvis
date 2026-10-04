import dayjs from "dayjs";
import * as satellitejs from "satellite.js";

import type { SwathExtents } from "../config/satelliteMetadata";
import { createSatrec, recordTleLines, type GpRecord } from "./util/gp";

const deg2rad = Math.PI / 180;
const rad2deg = 180 / Math.PI;

export interface GeodeticPosition {
  longitude: number; // degrees
  latitude: number; // degrees
  height: number; // meters
  velocity?: number; // km/s, present when calculateVelocity = true
}

export interface GroundStationPosition {
  longitude: number; // degrees
  latitude: number; // degrees
  height: number; // meters (converted to km internally before passing to satellite.js)
}

export interface ElevationPass {
  name: string;
  start: number;
  end: number;
  duration: number;
  azimuthStart: number;
  azimuthApex: number;
  azimuthEnd: number;
  maxElevation: number;
  apex?: number;
}

export interface SwathPass {
  name: string;
  start: number;
  end: number;
  duration: number;
  minDistance: number;
  minDistanceTime: number;
  swathWidth: number;
}

/** Which side of the ground track something lies on, relative to flight direction. */
export type SwathSide = "starboard" | "port";

/** A ground station's position relative to the ground track (see Orbit.trackOffsets). */
export interface TrackOffsets {
  side: SwathSide;
  distanceKm: number;
}

const EARTH_RADIUS_KM = 6371;
const POLAR_RADIUS_KM = 6356.752;

// Lookahead used to derive the ground-track bearing from two subpoints. Short
// enough that the track is locally straight, long enough that the two subpoints
// are ~75 km apart in LEO and the bearing is not dominated by rounding.
const BEARING_SAMPLE_MS = 10_000;

const MU_KM3_S2 = 398600.4418;
const EARTH_ROTATION_RAD_S = 7.2921159e-5;
const INV_PHI = (Math.sqrt(5) - 1) / 2;

// Pass edges and peaks are resolved to this. A kilometre-wide swath can serve a
// station for well under a second.
const PASS_RESOLUTION_MS = 10;
// How often an asymmetric swath re-reads which side of the track the station is on.
const SIDE_SAMPLE_MS = 1000;

/** Initial bearing from one geodetic point to another, all in radians. */
function bearingRad(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const deltaLon = toLon - fromLon;
  const y = Math.sin(deltaLon) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(deltaLon);
  return Math.atan2(y, x);
}

/** Great-circle distance (km) between two geodetic points, all in radians. */
function greatCircleKm(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const deltaLat = toLat - fromLat;
  const deltaLon = toLon - fromLon;
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Bisects to where `isInside` flips between `outsideMs` and `insideMs`, returning both bounds. */
function crossing(isInside: (timeMs: number) => boolean, outsideMs: number, insideMs: number): { outsideMs: number; insideMs: number } {
  let outside = outsideMs;
  let inside = insideMs;
  while (Math.abs(inside - outside) > PASS_RESOLUTION_MS) {
    const mid = (outside + inside) / 2;
    if (isInside(mid)) {
      inside = mid;
    } else {
      outside = mid;
    }
  }
  return { outsideMs: outside, insideMs: inside };
}

/**
 * The minimum of `cost` over `[lo, hi]` by golden-section search, which assumes a
 * single minimum there. `giveUp` is asked as the bracket narrows and ends the
 * search early, returning `undefined`.
 */
function minimum(cost: (timeMs: number) => number, lo: number, hi: number, giveUp?: (best: number, widthMs: number) => boolean): { timeMs: number; value: number } | undefined {
  let a = lo;
  let b = hi;
  let c = b - (b - a) * INV_PHI;
  let d = a + (b - a) * INV_PHI;
  let fc = cost(c);
  let fd = cost(d);
  while (b - a > PASS_RESOLUTION_MS) {
    if (giveUp?.(Math.min(fc, fd), b - a)) {
      return undefined;
    }
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - (b - a) * INV_PHI;
      fc = cost(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + (b - a) * INV_PHI;
      fd = cost(d);
    }
  }
  return fc < fd ? { timeMs: c, value: fc } : { timeMs: d, value: fd };
}

export default class Orbit {
  name: string;

  // The element set this orbit was built from; always present.
  record: GpRecord;

  // The three TLE lines, present only for kind:"tle" records so the entity info
  // panel can render them. Undefined for OMM-sourced orbits.
  tle?: string[];

  satrec: satellitejs.SatRec;

  constructor(name: string, record: GpRecord) {
    this.name = name;
    this.record = record;
    this.tle = recordTleLines(record);
    this.satrec = createSatrec(record);
  }

  get satnum(): string {
    return this.satrec.satnum;
  }

  get error(): number {
    return this.satrec.error;
  }

  get julianDate(): number {
    return this.satrec.jdsatepoch;
  }

  get orbitalPeriod(): number {
    const meanMotionRad = this.satrec.no;
    const period = (2 * Math.PI) / meanMotionRad;
    return period;
  }

  positionECI(time: Date): satellitejs.EciVec3<number> | null {
    const result = satellitejs.propagate(this.satrec, time);
    return result && typeof result.position !== "boolean" ? result.position : null;
  }

  positionECF(time: Date): satellitejs.EcfVec3<number> | null {
    const positionEci = this.positionECI(time);
    if (!positionEci) return null;
    const gmst = satellitejs.gstime(time);
    const positionEcf = satellitejs.eciToEcf(positionEci, gmst);
    return positionEcf;
  }

  positionGeodetic(timestamp: Date, calculateVelocity = false): GeodeticPosition | null {
    const result = satellitejs.propagate(this.satrec, timestamp);
    if (!result || typeof result.position === "boolean" || typeof result.velocity === "boolean") return null;
    const { position: positionEci, velocity: velocityVector } = result;
    const gmst = satellitejs.gstime(timestamp);
    const positionGd = satellitejs.eciToGeodetic(positionEci, gmst);

    return {
      longitude: positionGd.longitude * rad2deg,
      latitude: positionGd.latitude * rad2deg,
      height: positionGd.height * 1000,
      ...(calculateVelocity && {
        velocity: Math.sqrt(velocityVector.x * velocityVector.x + velocityVector.y * velocityVector.y + velocityVector.z * velocityVector.z),
      }),
    };
  }

  computePassesElevation(
    groundStationPosition: GroundStationPosition,
    startDate: Date = dayjs().toDate(),
    endDate: Date = dayjs(startDate).add(7, "day").toDate(),
    minElevation = 5,
    maxPasses = Number.POSITIVE_INFINITY,
  ): ElevationPass[] {
    const station = {
      latitude: groundStationPosition.latitude * deg2rad,
      longitude: groundStationPosition.longitude * deg2rad,
      height: groundStationPosition.height / 1000,
    };
    const lookAt = (timeMs: number) => {
      const positionEcf = this.positionECF(new Date(timeMs));
      return positionEcf ? satellitejs.ecfToLookAngles(station, positionEcf) : undefined;
    };
    const elevationAt = (timeMs: number) => (lookAt(timeMs)?.elevation ?? -Math.PI / 2) * rad2deg;
    const azimuthAt = (timeMs: number) => (lookAt(timeMs)?.azimuth ?? 0) * rad2deg;
    const isAbove = (timeMs: number) => elevationAt(timeMs) > minElevation;

    const pass = (start: number, end: number, apex: { timeMs: number; elevation: number }): ElevationPass => ({
      name: this.name,
      start,
      end,
      duration: end - start,
      azimuthStart: azimuthAt(start),
      azimuthApex: azimuthAt(apex.timeMs),
      azimuthEnd: azimuthAt(end),
      maxElevation: apex.elevation,
      apex: apex.timeMs,
    });

    const passes: ElevationPass[] = [];
    // An eccentric orbit can stay within reach for hours, setting and rising again,
    // so a reach is walked in steps short enough for one peak, and a pass running
    // over a step is carried on into the next.
    for (const reach of this.#reachIntervals(groundStationPosition, this.#visibilityRadiusKm(minElevation), startDate.getTime(), endDate.getTime())) {
      let open: { start: number; apex: { timeMs: number; elevation: number } } | undefined;
      for (let a = reach.start; a < reach.end; a += this.#scanStepMs) {
        const b = Math.min(a + this.#scanStepMs, reach.end);
        const atA = elevationAt(a);
        const atB = elevationAt(b);
        const inner = minimum((timeMs) => -elevationAt(timeMs), a, b)!;
        let apex = { timeMs: inner.timeMs, elevation: -inner.value };
        if (atA > apex.elevation) {
          apex = { timeMs: a, elevation: atA };
        }
        if (atB > apex.elevation) {
          apex = { timeMs: b, elevation: atB };
        }
        if (apex.elevation <= minElevation) {
          continue;
        }
        // A step starts above the horizon only mid-pass, which `open` carries, or
        // at the window's start.
        const start = open?.start ?? (atA > minElevation ? a : crossing(isAbove, a, apex.timeMs).insideMs);
        const peak = open && open.apex.elevation > apex.elevation ? open.apex : apex;
        if (atB > minElevation && b < reach.end) {
          open = { start, apex: peak };
          continue;
        }
        open = undefined;
        passes.push(pass(start, atB > minElevation ? b : crossing(isAbove, b, apex.timeMs).outsideMs, peak));
        if (passes.length >= maxPasses) {
          return passes;
        }
      }
    }
    return passes;
  }

  /**
   * Where a ground station sits relative to the ground track at `date`:
   *
   * - `distanceKm` — great-circle distance to the subpoint. This is the magnitude
   *   containment compares against, and the pass's closest approach.
   * - `side` — which side of the track the station is on, from the sign of its
   *   cross-track offset. Starboard is the velocity bearing + 90°. This is the
   *   only thing the cross-track decomposition is needed for: it selects WHICH
   *   extent applies, while `distanceKm` decides whether the station is within it.
   *
   * `undefined` when the position cannot be propagated.
   *
   * The flight bearing comes from two subpoints BEARING_SAMPLE_MS apart rather
   * than the velocity vector: positionGeodetic returns only the speed magnitude,
   * and rotating the ECI velocity into ECF without the ω × r term would skew the
   * bearing by a few degrees.
   */
  trackOffsets(groundStation: GroundStationPosition, date: Date): TrackOffsets | undefined {
    const here = this.positionGeodetic(date);
    const ahead = this.positionGeodetic(new Date(date.getTime() + BEARING_SAMPLE_MS));
    if (!here || !ahead) {
      return undefined;
    }
    const satLat = here.latitude * deg2rad;
    const satLon = here.longitude * deg2rad;
    const stationLat = groundStation.latitude * deg2rad;
    const stationLon = groundStation.longitude * deg2rad;

    const flightBearing = bearingRad(satLat, satLon, ahead.latitude * deg2rad, ahead.longitude * deg2rad);
    const stationBearing = bearingRad(satLat, satLon, stationLat, stationLon);
    const distanceKm = greatCircleKm(satLat, satLon, stationLat, stationLon);

    // sin() of the bearing difference carries the side: positive means the station
    // lies clockwise of the flight direction, i.e. to starboard. Only the sign is
    // used, so the cross-track magnitude is never computed.
    const side: SwathSide = Math.sin(stationBearing - flightBearing) >= 0 ? "starboard" : "port";

    return { side, distanceKm };
  }

  get #semiMajorAxisKm(): number {
    return Math.cbrt(MU_KM3_S2 / (this.satrec.no / 60) ** 2);
  }

  /** Short enough that the distance to a station, and the elevation, peak at most once per step. */
  get #scanStepMs(): number {
    return this.orbitalPeriod * 0.1 * 60_000;
  }

  /**
   * An upper bound on the subpoint's speed over the ground (km/s), and so on how
   * fast its distance to a station can change: the angular rate at perigee plus
   * the Earth's rotation, with margin for the perturbations SGP4 adds.
   */
  #maxGroundSpeedKmS(): number {
    const eccentricity = this.satrec.ecco;
    const perigeeKm = this.#semiMajorAxisKm * (1 - eccentricity);
    const perigeeRateRadS = Math.sqrt((MU_KM3_S2 * (1 + eccentricity)) / perigeeKm) / perigeeKm;
    return 1.1 * EARTH_RADIUS_KM * (perigeeRateRadS + EARTH_ROTATION_RAD_S);
  }

  /** Great-circle distance (km) from the subpoint to the station, `Infinity` where it cannot be propagated. */
  #subpointDistanceKm(groundStation: GroundStationPosition, timeMs: number): number {
    const here = this.positionGeodetic(new Date(timeMs));
    if (!here) {
      return Number.POSITIVE_INFINITY;
    }
    return greatCircleKm(here.latitude * deg2rad, here.longitude * deg2rad, groundStation.latitude * deg2rad, groundStation.longitude * deg2rad);
  }

  /**
   * The parts of `[from, to]` an asymmetric swath serves the station in. The side
   * it lies on usually holds for a whole pass, but not where the ground track
   * curves or reverses, so it is sampled rather than assumed.
   */
  #servedIntervals(groundStation: GroundStationPosition, swath: SwathExtents, from: number, to: number, closestMs: number): [number, number][] {
    const isServed = (timeMs: number) => {
      const offsets = this.trackOffsets(groundStation, new Date(timeMs));
      return offsets !== undefined && offsets.distanceKm <= (offsets.side === "port" ? swath.portKm : swath.starboardKm);
    };
    const times: number[] = [];
    for (let time = from; time < to; time += SIDE_SAMPLE_MS) {
      times.push(time);
    }
    times.push(to, closestMs);
    times.sort((a, b) => a - b);

    const intervals: [number, number][] = [];
    let start: number | undefined;
    let previous = from;
    for (const time of times) {
      const served = isServed(time);
      if (served && start === undefined) {
        start = time === from ? from : crossing(isServed, previous, time).insideMs;
      } else if (!served && start !== undefined) {
        intervals.push([start, crossing(isServed, time, previous).outsideMs]);
        start = undefined;
      }
      previous = time;
    }
    if (start !== undefined) {
      intervals.push([start, to]);
    }
    return intervals;
  }

  /**
   * The furthest the subpoint can be from a station (km) while the satellite is
   * above `minElevation`, at the highest the orbit gets.
   */
  #visibilityRadiusKm(minElevation: number): number {
    // Erring wide: the osculating orbit rises above the mean apogee, and a station
    // on the ellipsoid can sit as low as the polar radius.
    const apogeeKm = this.#semiMajorAxisKm * (1 + this.satrec.ecco) + 30;
    const elevation = minElevation * deg2rad;
    return 1.02 * EARTH_RADIUS_KM * (Math.acos((POLAR_RADIUS_KM * Math.cos(elevation)) / apogeeKm) - elevation);
  }

  /**
   * The stretches of `[startMs, endMs]` where the subpoint is within `radiusKm` of
   * the station, each with its closest approach. The scan steps short enough for
   * the distance to have one minimum per step, and skips a step the ground-speed
   * bound proves cannot reach the radius.
   */
  *#reachIntervals(groundStation: GroundStationPosition, radiusKm: number, startMs: number, endMs: number): Generator<{ start: number; end: number; closestMs: number }> {
    const maxSpeedKmS = this.#maxGroundSpeedKmS();
    const distanceAt = (timeMs: number) => this.#subpointDistanceKm(groundStation, timeMs);
    const unreachable = (best: number, widthMs: number) => best - (maxSpeedKmS * widthMs) / 1000 > radiusKm;

    let t = startMs;
    let distanceT = distanceAt(t);
    while (t < endMs) {
      const next = Math.min(t + this.#scanStepMs, endMs);
      const distanceNext = distanceAt(next);
      // No point between the two samples can be closer than the speed bound allows.
      if ((distanceT + distanceNext - (maxSpeedKmS * (next - t)) / 1000) / 2 > radiusKm) {
        t = next;
        distanceT = distanceNext;
        continue;
      }
      let closest = minimum(distanceAt, t, next, unreachable) ?? { timeMs: next, value: distanceNext };
      if (distanceNext < closest.value) {
        closest = { timeMs: next, value: distanceNext };
      }
      if (distanceT < closest.value) {
        closest = { timeMs: t, value: distanceT };
      }
      if (closest.value > radiusKm) {
        t = next;
        distanceT = distanceNext;
        continue;
      }

      // Only the window's start can already be within reach; every other `t` is outside.
      const withinReach = (timeMs: number) => distanceAt(timeMs) <= radiusKm;
      const start = distanceT <= radiusKm ? t : crossing(withinReach, t, closest.timeMs).insideMs;
      let end = endMs;
      for (let probe = closest.timeMs, gap = Math.max(closest.timeMs - start, 1000); probe < endMs; gap *= 2) {
        const ahead = Math.min(closest.timeMs + gap, endMs);
        if (!withinReach(ahead)) {
          end = crossing(withinReach, ahead, probe).outsideMs;
          break;
        }
        probe = ahead;
      }
      yield { start, end, closestMs: closest.timeMs };
      t = end;
      distanceT = distanceAt(t);
    }
  }

  computePassesSwath(
    groundStationPosition: GroundStationPosition,
    swath: SwathExtents,
    startDate: Date = dayjs().toDate(),
    endDate: Date = dayjs(startDate).add(7, "day").toDate(),
    maxPasses = Number.POSITIVE_INFINITY,
  ): SwathPass[] {
    const swathWidth = swath.starboardKm + swath.portKm;
    // The widest side bounds how far a station can be and still be served, so it
    // gates the search before the side is known.
    const maxExtent = Math.max(swath.starboardKm, swath.portKm);
    const distanceAt = (timeMs: number) => this.#subpointDistanceKm(groundStationPosition, timeMs);

    const passes: SwathPass[] = [];
    for (const reach of this.#reachIntervals(groundStationPosition, maxExtent, startDate.getTime(), endDate.getTime())) {
      // The footprint is a half-disc per side (ADR-0002). A symmetric swath is a
      // plain distance test, so the stretch within reach is the pass.
      const served =
        swath.starboardKm === swath.portKm ? [[reach.start, reach.end] as const] : this.#servedIntervals(groundStationPosition, swath, reach.start, reach.end, reach.closestMs);
      for (const [start, end] of served) {
        const closest = minimum(distanceAt, start, end)!;
        passes.push({
          name: this.name,
          start,
          end,
          duration: end - start,
          minDistance: closest.value,
          minDistanceTime: closest.timeMs,
          swathWidth,
        });
        if (passes.length >= maxPasses) {
          return passes;
        }
      }
    }
    return passes;
  }
}
