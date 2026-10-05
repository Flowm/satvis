// Static facts a GP record carries beside its element set (ADR 0002, 0006). Curated
// fields (satvis.core.yaml, plugins) beat SATCAT fields one by one (mergeSatelliteTables);
// `orbitClass` is derived here. The worker only copies the bag, so a new field needs no
// worker change, except the swath pair, whose both-or-neither rule the generator enforces.
// Cesium-free: node-env vitest exercises it.

import type { OrbitClass } from "./orbitClass";

/** Every field is optional; a consumer applies its default (DEFAULT_*, SatelliteProperties). */
export interface SatelliteMetadata {
  /**
   * Km from the ground track to each swath edge (starboard = velocity bearing + 90°). Not
   * halves of a width: the sides can differ (Sentinel-3 SLSTR). Both or neither.
   */
  swathStarboardKm?: number;
  swathPortKm?: number;
  coneFovDeg?: number;
  /** Path under /data/models/, from a model manifest (ADR 0007). */
  modelFile?: string;
  /** Display-only free text. */
  operator?: string;
  missionType?: string;

  // Raw SATCAT codes, labelled by satcatCodes.ts; absent when upstream's cell is empty.

  /** Registration code, e.g. "US", "ESA", "PRC"; `operator` is curated free text. */
  owner?: string;
  /** ISO date, e.g. "1998-11-20". */
  launchDate?: string;
  launchSite?: string;
  /** Operational status, e.g. "+" (operational) or "P" (partially operational). */
  opsStatus?: string;
  /** "ORB", "DOC" (docked), "IMP", "LAN", "R/T". Not the orbit regime: that is `orbitClass`. */
  orbitType?: string;
  /** "EA" for the Earth, otherwise the host's NORAD id (a module docked to the ISS). */
  orbitCenter?: string;
  /** ISO date; present only once the object has re-entered. */
  decayDate?: string;

  /**
   * Cached by `parseGpPayload`; read through `CatalogEntry.orbitClass`.
   * `cacheOrbitClass` overwrites it, so no served field may use the name.
   */
  orbitClass?: OrbitClass;
}

/** Total width, not per side. */
export const DEFAULT_SWATH_KM = 200;

export const DEFAULT_CONE_FOV_DEG = 10;

/** Per-side cross-track extents (km) from the ground track, relative to flight direction. */
export interface SwathExtents {
  starboardKm: number;
  portKm: number;
}

/** `undefined` when the record carries none, so the info panel never shows a default as fact. */
export function swathExtentsOf(metadata: SatelliteMetadata): SwathExtents | undefined {
  const { swathStarboardKm, swathPortKm } = metadata;
  if (swathStarboardKm === undefined || swathPortKm === undefined) {
    return undefined;
  }
  return { starboardKm: swathStarboardKm, portKm: swathPortKm };
}
