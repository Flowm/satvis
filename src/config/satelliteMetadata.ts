// Per-satellite metadata: the static facts a GP record carries alongside its
// element set. Three provenances, and which one a field came from decides what
// its absence means:
//
//   curated   hand-written in worker/src/config/satvis.core.yaml (and plugin
//             configs) for the ~19 satellites worth saying something specific
//             about — swath extents, sensor cones, models
//   upstream  the CelesTrak SATCAT, covering every satellite we serve, fetched
//             and merged into the same satellite table (worker/src/gp/satcat.ts)
//   derived   `orbitClass`, computed by the frontend at parse time, because it
//             follows from the element set every satellite already has
//
// Curated beats upstream field by field (see mergeSatelliteTables), and neither
// can supply `orbitClass`.
//
// The worker treats the bag as opaque and only copies it, so this file is the
// single place where it acquires meaning. Adding a field costs a declaration here,
// a value in the YAML, and a reader wherever it should show up (for a display-only
// field, a row in entityInfo.getSatelliteInfo) — but no worker or pipeline change,
// because nothing between the config and this file inspects the payload. The one
// exception is the swath pair, whose both-or-neither rule the generator enforces.
//
// This module must stay Cesium-free (node-env vitest exercises it).

import type { OrbitClass } from "./orbitClass";

// Static facts about one satellite. Every field is optional: a record either
// carries a value or the consumer applies its own default (see the DEFAULT_*
// constants below and SatelliteProperties).
export interface SatelliteMetadata {
  // Cross-track distance (km) from the ground track to the swath edge, per side,
  // relative to flight direction (starboard = velocity bearing + 90°). NOT
  // halves of a full width — the sides can differ, e.g. Sentinel-3's SLSTR is
  // tilted against sunglint. Given for both sides or neither (the generator
  // rejects a half-specified swath), so consumers read them as a pair.
  swathStarboardKm?: number;
  swathPortKm?: number;
  coneFovDeg?: number;
  // The 3D model's path under /data/models/, from a model manifest (ADR 0007).
  modelFile?: string;
  // Display-only, free text, shown verbatim in the entity info panel.
  operator?: string;
  missionType?: string;

  // From the CelesTrak SATCAT (worker/src/gp/satcat.ts): raw upstream codes,
  // resolved to labels at display time via src/config/satcatCodes.ts. Absent
  // whenever upstream's cell was empty, which is what keeps the bag from costing
  // bytes to say nothing.

  // Owning country or organization, e.g. "US", "ESA", "PRC". Distinct from
  // `operator` above: that is curated free text naming who flies the thing,
  // this is upstream's registration code.
  owner?: string;
  // ISO date, e.g. "1998-11-20".
  launchDate?: string;
  launchSite?: string;
  // Operational status, e.g. "+" (operational) or "P" (partially operational).
  opsStatus?: string;
  // How the object moves: "ORB", "DOC" (docked to another object), "IMP",
  // "LAN", "R/T". NOT the orbit regime — that is `orbitClass` below, which is
  // derived here rather than served, and the two must not be conflated.
  orbitType?: string;
  // What it orbits: "EA" for the Earth, otherwise the NORAD id of its host —
  // which is how a module docked to the ISS says so.
  orbitCenter?: string;
  // ISO date; present only once the object has re-entered.
  decayDate?: string;

  // The one derived member of the bag, cached by `parseGpPayload` for every
  // record rather than supplied by the satellite table. Read through
  // `CatalogEntry.orbitClass`, which is the only place its absence is handled.
  //
  // Note for anyone adding a served field: `cacheOrbitClass` overwrites this key
  // unconditionally, so nothing upstream may claim the name.
  orbitClass?: OrbitClass;
}

// Total swath width for a satellite with no extents of its own. Kept as a total
// rather than a pair of per-side halves so "200 km wide by default" is stated
// once, and a half-specified swath cannot arise here either.
export const DEFAULT_SWATH_KM = 200;

export const DEFAULT_CONE_FOV_DEG = 10;

/**
 * Per-side cross-track extents of a sensor footprint (km), measured from the
 * ground track outwards relative to flight direction.
 *
 * Lives here rather than beside its consumers because the pair is one domain
 * value: the two fields are stored together, validated together (the generator
 * rejects a half-specified swath) and read together.
 */
export interface SwathExtents {
  starboardKm: number;
  portKm: number;
}

/**
 * The satellite's own extents, or `undefined` when its record carries none.
 *
 * The single place the both-or-neither rule is interpreted. Callers that need a
 * usable value fall back to a default; callers that must distinguish real data
 * from a fallback — the info panel, which would otherwise present a renderer
 * default as a fact — check for `undefined`.
 */
export function swathExtentsOf(metadata: SatelliteMetadata): SwathExtents | undefined {
  const { swathStarboardKm, swathPortKm } = metadata;
  if (swathStarboardKm === undefined || swathPortKm === undefined) {
    return undefined;
  }
  return { starboardKm: swathStarboardKm, portKm: swathPortKm };
}
