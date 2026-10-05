// Orbit facts derived from the element set rather than served with it. Cesium-free
// so node-env vitest can exercise it.

import { constants, gstime, type SatRec } from "satellite.js";

import type Orbit from "../Orbit";

const RAD_TO_DEG = 180 / Math.PI;
const HOURS_PER_DEGREE = 24 / 360;
const MINUTES_PER_DAY = 1440;

/** The sun's mean motion in right ascension: 360° per tropical year. */
const SUN_DEG_PER_DAY = 360 / 365.2422;

/**
 * How far the node's precession may miss the sun's, in °/day: about 12 min of
 * local-time drift per month, or a ±0.5° inclination window. It still admits TERRA,
 * no longer station-kept, at ~0.014°/day off.
 */
const SUN_SYNC_TOLERANCE_DEG_PER_DAY = 0.05;

/**
 * Nodal regression from J₂, in °/day, from the SGP4-recovered (not Kozai) elements:
 *
 *   Ω̇ = −(3/2) J₂ n (Rₑ/a)² cos i / (1−e²)²
 */
function nodalPrecessionDegPerDay(satrec: SatRec): number {
  const { no, a, ecco, inclo } = satrec;
  if (!Number.isFinite(no) || !Number.isFinite(a) || a <= 0) {
    return Number.NaN;
  }
  const oneMinusESquared = 1 - ecco * ecco;
  const ratePerMinute = (-1.5 * constants.j2 * no * Math.cos(inclo)) / (a * a * oneMinusESquared * oneMinusESquared);
  return ratePerMinute * RAD_TO_DEG * MINUTES_PER_DAY;
}

/**
 * Not a value of `OrbitClass`: every SSO is also LEO, and `isLeo` in
 * satelliteGraphics.ts (`orbitClass === "LEO"`) gates the ground track and sensor cone.
 */
export function isSunSynchronous(satrec: SatRec): boolean {
  const rate = nodalPrecessionDegPerDay(satrec);
  return Number.isFinite(rate) && Math.abs(rate - SUN_DEG_PER_DAY) <= SUN_SYNC_TOLERANCE_DEG_PER_DAY;
}

/** Km above SGP4's equatorial radius; `sgp4init` leaves `alta`/`altp` in Earth radii. */
function apsideRows(satrec: SatRec): [string, string][] {
  if (!Number.isFinite(satrec.alta) || !Number.isFinite(satrec.altp)) {
    return [];
  }
  const apogee = (satrec.alta * constants.earthRadius).toFixed(0);
  const perigee = (satrec.altp * constants.earthRadius).toFixed(0);
  return [["Apogee / Perigee", `${apogee} / ${perigee} km`]];
}

/**
 * Local mean solar time of the node crossings at epoch, with no sun ephemeris:
 *
 *   LTAN = UT + (Ω − GMST) / 15°/h
 *
 * Mean, not apparent, solar time is what mission specs quote. Only sun-synchronous
 * orbits hold these times; the ISS drifts through every local time in about two months.
 */
function nodeCrossingRows(satrec: SatRec): [string, string][] {
  if (!isSunSynchronous(satrec)) {
    return [];
  }
  const jd = satrec.jdsatepoch;
  if (!Number.isFinite(jd)) {
    return [];
  }
  // A Julian day starts at noon, so the half-day offset turns the fraction into UT.
  const utHours = ((((jd + 0.5) % 1) + 1) % 1) * 24;
  const nodeLongitudeDeg = (satrec.nodeo - gstime(jd)) * RAD_TO_DEG;
  const ltan = wrapHours(utHours + nodeLongitudeDeg * HOURS_PER_DEGREE);
  return [["LTAN / LTDN", `${formatHours(ltan)} / ${formatHours(wrapHours(ltan + 12))}`]];
}

export function orbitRegimeLabel(orbitClass: string, orbit: Orbit): string {
  if (orbit.error !== 0 || !isSunSynchronous(orbit.satrec)) {
    return orbitClass;
  }
  return `${orbitClass} · Sun-synchronous`;
}

export function derivedOrbitRows(orbit: Orbit): [string, string][] {
  if (orbit.error !== 0) {
    return [];
  }
  return [...apsideRows(orbit.satrec), ...nodeCrossingRows(orbit.satrec)];
}

function wrapHours(hours: number): number {
  return ((hours % 24) + 24) % 24;
}

function formatHours(hours: number): string {
  const totalMinutes = Math.round(hours * 60) % (24 * 60);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
