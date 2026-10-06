// Static facts a GP record carries beside its element set (ADR 0002, 0006, 0008). Every
// field has one owner: curated rows (satvis.core.yaml, plugins, model manifests), SATCAT,
// or GCAT, and curated rows may override an upstream field (mergeSatelliteTables).
// `orbitClass` is derived here. A curated field needs no worker change, except the swath
// pair, whose both-or-neither rule the generator enforces; an upstream field is mapped
// by its parser (worker/src/gp/satcat.ts, gcat.ts). Cesium-free: node-env vitest exercises it.

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
  /** Curated, display-only free text. */
  missionType?: string;

  // From GCAT, organisation and country names resolved by the worker; absent where GCAT
  // has none yet (~12 weeks for a new satellite) or its cell is "-".

  /** The country, or the intergovernmental body, responsible for it: "USA", "Germany", "ESA". */
  country?: string;
  /** Who runs it: "SpaceX (Seattle)". Several join with " / ". */
  operator?: string;
  /** Who built it. Several join with " / ". */
  manufacturer?: string;
  /** GCAT's bus name: "Starlink V2M", "A2100". */
  bus?: string;
  /** Launch mass, kg. */
  massKg?: number;
  /** Metres: the body's longest dimension. */
  lengthM?: number;
  /** Metres: the body's second dimension. */
  diameterM?: number;
  /** Metres: the extent with arrays and booms. */
  spanM?: number;
  /** Free text: "Box + 2 Pan". */
  shape?: string;
  /** The keys among these GCAT flags as estimates, e.g. ["spanM"]. */
  estimated?: string[];
  /** GCAT purpose codes, labelled by gcatCodes.ts: "COM", "IMG/TECH". */
  category?: string;
  /** GCAT owner-type code, labelled by gcatCodes.ts: "B" commercial, "D" military. */
  class?: string;

  // Raw SATCAT codes, labelled by satcatCodes.ts; absent when upstream's cell is empty.

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
