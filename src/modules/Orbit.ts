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

// Lookahead used to derive the ground-track bearing from two subpoints. Short
// enough that the track is locally straight, long enough that the two subpoints
// are ~75 km apart in LEO and the bearing is not dominated by rounding.
const BEARING_SAMPLE_MS = 10_000;

/**
 * An upper bound on ground-track speed (km/s) for any orbit this app
 * predicts — ISS-class LEO runs under 7 km/s, and this stays safely above
 * that down to the lowest altitudes satellite.js can propagate. Used only to
 * prove a coarse step could not possibly have closed to within a swath's
 * extent, never to size the step itself, so overestimating it costs a few
 * needless minimisations rather than a missed pass.
 */
const MAX_GROUND_SPEED_KM_S = 8.5;

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
    maxPasses = 50,
  ): ElevationPass[] {
    const groundStation = { ...groundStationPosition };
    groundStation.latitude *= deg2rad;
    groundStation.longitude *= deg2rad;
    groundStation.height /= 1000;

    const date = new Date(startDate);
    const passes: ElevationPass[] = [];
    let pass: Partial<ElevationPass> | null = null;
    let ongoingPass = false;
    let lastElevation = 0;
    // eslint-disable-next-line no-unmodified-loop-condition -- date is mutated via setMinutes/setSeconds
    while (date < endDate) {
      const positionEcf = this.positionECF(date);
      if (!positionEcf) {
        date.setMinutes(date.getMinutes() + 1);
        continue;
      }
      const lookAngles = satellitejs.ecfToLookAngles(groundStation, positionEcf);
      const elevation = lookAngles.elevation / deg2rad;

      if (elevation > minElevation) {
        if (!ongoingPass) {
          pass = {
            name: this.name,
            start: date.getTime(),
            azimuthStart: lookAngles.azimuth,
            maxElevation: elevation,
            azimuthApex: lookAngles.azimuth,
          };
          ongoingPass = true;
        } else if (pass && elevation > (pass.maxElevation ?? -Infinity)) {
          pass.maxElevation = elevation;
          pass.apex = date.getTime();
          pass.azimuthApex = lookAngles.azimuth;
        }
        date.setSeconds(date.getSeconds() + 5);
      } else if (ongoingPass && pass) {
        pass.end = date.getTime();
        pass.duration = (pass.end as number) - (pass.start as number);
        pass.azimuthEnd = lookAngles.azimuth;
        pass.azimuthStart = (pass.azimuthStart as number) / deg2rad;
        pass.azimuthApex = (pass.azimuthApex as number) / deg2rad;
        pass.azimuthEnd = (pass.azimuthEnd as number) / deg2rad;
        passes.push(pass as ElevationPass);
        if (passes.length >= maxPasses) {
          break;
        }
        ongoingPass = false;
        lastElevation = -180;
        date.setMinutes(date.getMinutes() + this.orbitalPeriod * 0.5);
      } else {
        const deltaElevation = elevation - lastElevation;
        lastElevation = elevation;
        if (deltaElevation < 0) {
          date.setMinutes(date.getMinutes() + this.orbitalPeriod * 0.5);
          lastElevation = -180;
        } else if (elevation < -20) {
          date.setMinutes(date.getMinutes() + 5);
        } else if (elevation < -5) {
          date.setMinutes(date.getMinutes() + 1);
        } else if (elevation < -1) {
          date.setSeconds(date.getSeconds() + 5);
        } else {
          date.setSeconds(date.getSeconds() + 2);
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

  /**
   * The subpoint-to-station distance (km) at `date`, or `Infinity` where it
   * cannot be propagated — a plain number so it can be minimized over, unlike
   * `trackOffsets`'s `undefined` which a search has nothing to compare.
   */
  #trackDistanceKm(groundStationPosition: GroundStationPosition, date: Date): number {
    return this.trackOffsets(groundStationPosition, date)?.distanceKm ?? Number.POSITIVE_INFINITY;
  }

  /**
   * The time of closest approach inside `[lo, hi]`, by golden-section search.
   *
   * Assumes the distance is unimodal across the bracket — true for one orbit's
   * single conjunction with a fixed point, which is what every bracket here
   * spans. Shrinks to 10 ms: a kilometre-scale sensor's whole catchment window
   * can be under a tenth of a second, so this has to resolve finer than the
   * event it is looking for, not just finer than the coarse ladder around it.
   */
  #closestApproachInBracket(groundStationPosition: GroundStationPosition, lo: number, hi: number): { timeMs: number; distanceKm: number } {
    const invphi = (Math.sqrt(5) - 1) / 2;
    let a = lo;
    let b = hi;
    for (let i = 0; i < 100 && b - a > 10; i++) {
      const c = b - (b - a) * invphi;
      const d = a + (b - a) * invphi;
      if (this.#trackDistanceKm(groundStationPosition, new Date(c)) < this.#trackDistanceKm(groundStationPosition, new Date(d))) {
        b = d;
      } else {
        a = c;
      }
    }
    const timeMs = (a + b) / 2;
    return { timeMs, distanceKm: this.#trackDistanceKm(groundStationPosition, new Date(timeMs)) };
  }

  /**
   * Where distance crosses `extentKm` inside `[outsideMs, insideMs]`, by
   * bisection. `outsideMs`'s distance must exceed `extentKm` and `insideMs`'s
   * must not — the two sides of one monotonic slope down to (or up from) the
   * closest approach found by `#closestApproachInBracket`, which is what
   * every call site here provides. Returns both bounds as bisection leaves
   * them, each still on its own side, a sample apart: `insideMs` for a pass's
   * start (the first moment it is, in fact, inside) and `outsideMs` for its
   * end (the first moment it no longer is) — the same convention the coarse
   * scan around this uses.
   */
  #crossingInBracket(groundStationPosition: GroundStationPosition, outsideMs: number, insideMs: number, extentKm: number): { outsideMs: number; insideMs: number } {
    let lo = outsideMs;
    let hi = insideMs;
    for (let i = 0; i < 60 && Math.abs(hi - lo) > 10; i++) {
      const mid = (lo + hi) / 2;
      if (this.#trackDistanceKm(groundStationPosition, new Date(mid)) <= extentKm) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return { outsideMs: lo, insideMs: hi };
  }

  /**
   * The far side of the extent crossing after `fromMs` (itself inside), by
   * doubling outward from `gapMs` — the entry's own distance from the closest
   * approach, and so already the right order of magnitude for the exit's — until
   * a sample lands outside, then bisecting. Bounded by `boundMs`; returns it
   * outright if nothing outside is found by then (a pass still open at the
   * window's own end, which the caller leaves for its normal "ongoing" branch
   * to pick up and truncate the same way it already does).
   */
  #exitCrossingAfter(groundStationPosition: GroundStationPosition, fromMs: number, gapMs: number, extentKm: number, boundMs: number): number {
    let step = Math.max(gapMs, 1000);
    let probe = Math.min(fromMs + step, boundMs);
    while (this.#trackDistanceKm(groundStationPosition, new Date(probe)) <= extentKm) {
      if (probe >= boundMs) {
        return boundMs;
      }
      step *= 2;
      probe = Math.min(fromMs + step, boundMs);
    }
    return this.#crossingInBracket(groundStationPosition, probe, fromMs, extentKm).outsideMs;
  }

  computePassesSwath(
    groundStationPosition: GroundStationPosition,
    swath: SwathExtents,
    startDate: Date = dayjs().toDate(),
    endDate: Date = dayjs(startDate).add(7, "day").toDate(),
    maxPasses = 50,
  ): SwathPass[] {
    const swathWidth = swath.starboardKm + swath.portKm;
    // The widest side bounds how far a station can be and still be served, so it
    // drives the coarse time-stepping below (which runs before the side is known).
    const maxExtent = Math.max(swath.starboardKm, swath.portKm);
    const extentFor = (side: SwathSide): number => (side === "starboard" ? swath.starboardKm : swath.portKm);

    const date = new Date(startDate);
    const passes: SwathPass[] = [];
    let pass: Partial<SwathPass> | null = null;
    let ongoingPass = false;

    // eslint-disable-next-line no-unmodified-loop-condition -- date is mutated via setMinutes/setSeconds
    while (date < endDate) {
      const offsets = this.trackOffsets(groundStationPosition, date);
      if (offsets === undefined) {
        date.setMinutes(date.getMinutes() + 1);
        continue;
      }
      const { side, distanceKm } = offsets;

      // The footprint is a half-disc per side: the station is served when its
      // distance to the subpoint is within the extent of the side it lies on.
      //
      // For a symmetric swath both sides share one radius and this is byte-for-byte
      // the test used before (`distanceKm <= swathKm / 2`), so the 37 symmetric
      // satellites keep their pass windows exactly. An asymmetric sensor narrows
      // only the side that is actually narrower.
      const extentKm = extentFor(side);

      if (distanceKm <= extentKm) {
        if (!ongoingPass) {
          pass = {
            name: this.name,
            start: date.getTime(),
            minDistance: distanceKm,
            minDistanceTime: date.getTime(),
            swathWidth,
          };
          ongoingPass = true;
        } else if (pass && distanceKm < (pass.minDistance ?? Infinity)) {
          pass.minDistance = distanceKm;
          pass.minDistanceTime = date.getTime();
        }
        date.setSeconds(date.getSeconds() + 30); // 30 second steps during pass
      } else if (ongoingPass && pass) {
        pass.end = date.getTime();
        pass.duration = (pass.end as number) - (pass.start as number);
        passes.push(pass as SwathPass);
        if (passes.length >= maxPasses) {
          break;
        }
        ongoingPass = false;
        // Skip ahead to avoid immediate re-entry
        date.setMinutes(date.getMinutes() + Math.max(5, this.orbitalPeriod * 0.1));
      } else {
        // A ladder rather than one step size: coarse while the station is far,
        // fine as it closes — the step about to be taken, not yet applied.
        let stepMs: number;
        if (distanceKm > maxExtent * 3) {
          stepMs = Math.max(10, this.orbitalPeriod * 0.2) * 60_000;
        } else if (distanceKm > maxExtent * 2) {
          stepMs = 5 * 60_000;
        } else {
          stepMs = 1 * 60_000;
        }
        const nextMs = Math.min(date.getTime() + stepMs, endDate.getTime());

        // Whether a real conjunction is hiding inside the step about to be
        // taken cannot be read off its two endpoints: comparing them against
        // each other (or against the previous step) is exactly what let a
        // narrow pass fall between two samples in the first place, because a
        // step can still read as "closer than before" for one or more steps
        // after its true closest approach already came and went, simply from
        // the wider multi-step trend. So every step is minimised over its own
        // interval before being taken, rather than only reacting to an
        // apparent reversal between samples — coarse search with the
        // refinement built into each step, rather than triggered by one.
        //
        // That minimisation is the one part of this fine enough to matter if
        // it ran on every step of a multi-day scan, so it only runs where a
        // conjunction is physically possible: no satellite this predicts
        // closes distance faster than MAX_GROUND_SPEED_KM_S, so a step that
        // could not reach the extent even at that speed is skipped outright.
        // This is what keeps "coarse search, with refinement" coarse over the
        // long stretch of a window nothing is happening in, rather than
        // minimising every single step regardless.
        if (distanceKm - MAX_GROUND_SPEED_KM_S * ((nextMs - date.getTime()) / 1000) > maxExtent) {
          date.setTime(nextMs);
          continue;
        }

        const closest = this.#closestApproachInBracket(groundStationPosition, date.getTime(), nextMs);
        const atClosest = this.trackOffsets(groundStationPosition, new Date(closest.timeMs));
        const closestExtent = atClosest ? extentFor(atClosest.side) : extentKm;

        if (atClosest && closest.distanceKm <= closestExtent) {
          // A real pass is hiding in this step. The branch above tracks an
          // ongoing pass at a 30-second dwell step, which is coarse enough to
          // miss the same way the outer ladder did — a grazing conjunction
          // this close to the extent's edge can cross in and out well inside
          // thirty seconds, on a swath of any width, not only a narrow one
          // (see the 100 km case this was found against). So entry, the
          // minimum, and exit are all resolved here, analytically, and the
          // pass recorded directly — the dwell step is still what the branch
          // above is for whenever a pass turns out to last longer than one of
          // its own steps, which most do.
          const entryMs = this.#crossingInBracket(groundStationPosition, date.getTime(), closest.timeMs, closestExtent).insideMs;
          const exitMs = this.#exitCrossingAfter(groundStationPosition, closest.timeMs, closest.timeMs - entryMs, closestExtent, endDate.getTime());
          passes.push({
            name: this.name,
            start: entryMs,
            end: exitMs,
            duration: exitMs - entryMs,
            minDistance: closest.distanceKm,
            minDistanceTime: closest.timeMs,
            swathWidth,
          });
          if (passes.length >= maxPasses) {
            break;
          }
          // Skip ahead to avoid immediately re-finding the same conjunction.
          date.setTime(exitMs);
          date.setMinutes(date.getMinutes() + Math.max(5, this.orbitalPeriod * 0.1));
          continue;
        }

        date.setTime(nextMs);
      }
    }

    return passes;
  }
}
