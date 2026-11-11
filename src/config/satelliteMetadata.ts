// Static facts a GP record carries beside its element set (ADR 0002, 0006, 0008, 0018).
// Every field has one owner: curated rows (satvis.core.yaml, plugins, model manifests),
// SATCAT, GCAT or CEOS, and curated rows may override an upstream field (SatelliteTable).
// A curated field needs no worker change, except the swath pair, whose both-or-neither
// rule the generator enforces; an upstream field is mapped by its parser
// (worker/src/gp/satcat.ts, gcat.ts, ceos.ts). Cesium-free: node-env vitest exercises it.

/** Worker `SatelliteModel` (worker/src/gp/types.ts): a satellite's 3D model and the copies drawn while it is small (ADR 0007). */
export interface SatelliteModel {
  /** Under /data/models/. */
  file: string;
  /** Most detailed first. */
  lods?: ModelLod[];
}

/** Worker `ModelLod`: a lower-detail copy, drawn while its model's bounding sphere spans at most `maxPoints` points, CSS pixels here. */
export interface ModelLod {
  /** Under /data/models/, as the model's file is. */
  file: string;
  maxPoints: number;
}

/** Worker `SatelliteInstrument`: one instrument the satellite carries, as CEOS lists it (ADR 0018). */
export interface SatelliteInstrument {
  /** CEOS's short name: "MODIS", "MSI (Sentinel-2)". */
  name: string;
  /** "MODerate-Resolution Imaging Spectroradiometer"; absent where it only repeats `name`. */
  fullName?: string;
  /** What it is, in CEOS's words: "Imaging radar (SAR)". */
  kind?: string;
  /** CEOS's waveband classes, shortest wavelength first, then radar bands: "VIS", "TIR", "MW", "C-Band". */
  bands?: string[];
  /** Metres: its finest band's, so Landsat's OLI says 15, its panchromatic band. */
  resolutionM?: number;
  /**
   * Km: the nominal width across both sides. Not the swath extents, which are calibrated
   * and drawn, and meaningless off a low orbit: CEOS gives a geostationary imager 500 km.
   */
  swathKm?: number;
  /** Its mission is over, though the satellite is still up. */
  retired?: boolean;
}

/** Every field is optional; a consumer applies its default (DEFAULT_*, SatelliteProperties). */
export interface SatelliteMetadata {
  /**
   * Km from the ground track to each swath edge (starboard = velocity bearing + 90°). Not
   * halves of a width: the sides can differ (Sentinel-3 SLSTR). Both or neither.
   */
  swathStarboardKm?: number;
  swathPortKm?: number;
  coneFovDeg?: number;
  /** From the model manifests (ADR 0007); read through satelliteModel(). */
  model?: SatelliteModel;
  /** `model.file`, for apps released before `model`, and all a record cached before it carries. */
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
  /** Metres: the main body's length, as GCAT gives it; often shorter than its diameter. */
  lengthM?: number;
  /** Metres: the main body's diameter, or its width. */
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
  /** GCAT's operational orbit code, "LLEO/S", "GEO/D"; read through `CatalogEntry.orbitKind`. */
  opOrbit?: string;
  /** GCAT's programme: "Starlink 2MO S1", "OneWeb", "TsM". Its first word names the constellation. */
  program?: string;

  /**
   * From CEOS, for the few hundred satellites its agencies report: the ones still flown
   * first. Hosted payloads are their host's, so the ISS carries a dozen.
   */
  instruments?: SatelliteInstrument[];

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
}

/** The satellite's model: `model`, else the `modelFile` a payload from before `model` carries alone. */
export function satelliteModel(metadata: SatelliteMetadata): SatelliteModel | undefined {
  return metadata.model ?? (metadata.modelFile === undefined ? undefined : { file: metadata.modelFile });
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
