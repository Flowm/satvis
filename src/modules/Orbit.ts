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
    // undefined rather than 0: a real 0 would make the first sample read as
    // declining whenever true elevation is negative, which skips an entire
    // imminent pass (ahead by half an orbit) if the window happens to open
    // while the satellite is still below the horizon but already rising.
    let lastElevation: number | undefined;
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
        // No real previous sample yet: nothing to call declining, so fall
        // straight through to the elevation-banded ladder below.
        const deltaElevation = lastElevation === undefined ? 0 : elevation - lastElevation;
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
    // A pass still open when the window ends is real, not a sample away from
    // qualifying — dropping it here would be inconsistent with the pass this
    // same loop already reports truncated when the window instead opens
    // mid-pass. Truncate it at the window edge rather than losing it.
    if (ongoingPass && pass) {
      const positionEcf = this.positionECF(endDate);
      const endAzimuth = positionEcf ? satellitejs.ecfToLookAngles(groundStation, positionEcf).azimuth : (pass.azimuthApex as number);
      pass.end = endDate.getTime();
      pass.duration = (pass.end as number) - (pass.start as number);
      pass.azimuthEnd = endAzimuth / deg2rad;
      pass.azimuthStart = (pass.azimuthStart as number) / deg2rad;
      pass.azimuthApex = (pass.azimuthApex as number) / deg2rad;
      passes.push(pass as ElevationPass);
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

    const date = new Date(startDate);
    const passes: SwathPass[] = [];
    let pass: Partial<SwathPass> | null = null;
    let ongoingPass = false;
    let lastDistance = Number.MAX_VALUE;

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
      const extentKm = side === "starboard" ? swath.starboardKm : swath.portKm;

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
        lastDistance = Number.MAX_VALUE;
        // Skip ahead to avoid immediate re-entry
        date.setMinutes(date.getMinutes() + Math.max(5, this.orbitalPeriod * 0.1));
      } else {
        // A ladder rather than one step size: coarse while the station is far
        // and receding, fine as it closes. A step small enough never to miss a
        // pass would otherwise walk the whole window at that resolution.
        const deltaDistance = distanceKm - lastDistance;
        lastDistance = distanceKm;

        if (deltaDistance > 0 && distanceKm > maxExtent * 3) {
          date.setMinutes(date.getMinutes() + Math.max(10, this.orbitalPeriod * 0.2));
        } else if (distanceKm > maxExtent * 2) {
          date.setMinutes(date.getMinutes() + 5);
        } else {
          date.setMinutes(date.getMinutes() + 1);
        }
      }
    }

    return passes;
  }
}
