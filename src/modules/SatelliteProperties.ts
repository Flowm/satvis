import type { OrbitClass } from "../config/orbitClass";
import {
  DEFAULT_CONE_FOV_DEG,
  DEFAULT_SWATH_KM,
  satelliteModel,
  swathExtentsOf,
  type SatelliteMetadata,
  type SatelliteModel,
  type SwathExtents,
} from "../config/satelliteMetadata";
import Orbit from "./Orbit";
import { PassPredictor } from "./PassPredictor";
import { SampledTrajectory } from "./SampledTrajectory";
import type { CatalogEntry } from "./SatelliteCatalog";
import type { PassPredictorSource } from "./util/passSource";
import type { TrajectorySampler } from "./util/sampleSource";

export class SatelliteProperties {
  entry: CatalogEntry;

  name: string;

  orbit: Orbit;

  satnum: string;

  readonly passPredictor: PassPredictor;

  readonly trajectory: SampledTrajectory;

  constructor(entry: CatalogEntry, sampler: TrajectorySampler, passes: PassPredictorSource) {
    this.entry = entry;
    this.name = entry.name;
    this.satnum = entry.satnum;
    this.orbit = new Orbit(entry.name, entry.record);
    this.passPredictor = new PassPredictor(this.swathExtents, passes);
    this.trajectory = new SampledTrajectory(this.orbit, sampler);
  }

  get metadata(): SatelliteMetadata {
    return this.entry.metadata;
  }

  get orbitClass(): OrbitClass {
    return this.entry.orbitClass;
  }

  /** Its 3D model, if a model manifest gives it one (ADR 0007). */
  get model(): SatelliteModel | undefined {
    return satelliteModel(this.metadata);
  }

  /** Per-side cross-track swath extents (km). Defaults to a symmetric split of DEFAULT_SWATH_KM. */
  get swathExtents(): SwathExtents {
    return swathExtentsOf(this.metadata) ?? { starboardKm: DEFAULT_SWATH_KM / 2, portKm: DEFAULT_SWATH_KM / 2 };
  }

  /** Half-angle, degrees. */
  get coneFovDeg(): number {
    return this.metadata.coneFovDeg ?? DEFAULT_CONE_FOV_DEG;
  }
}
