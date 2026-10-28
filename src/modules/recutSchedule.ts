// When the orbit tracks are re-cut as simulation time passes. Cesium-free bookkeeping,
// so it is tested without a viewer; SatelliteManager asks it once per clock tick and
// does the re-cutting. The ground tracks keep their own time (GroundTrackBatch).

import { JulianDate } from "@cesium/core";

import { geometryRefreshSeconds } from "./satelliteGraphics";

/** Paces the orbit tracks' re-cuts by how many satellites are active. */
export class RecutSchedule {
  /** Simulation time. */
  #tracksRefreshedAt: JulianDate;

  constructor(start: JulianDate) {
    this.#tracksRefreshedAt = start;
  }

  /**
   * Whether the orbit tracks of `count` active satellites are due. Every tick: a grid makes a
   * declined re-cut wait out the whole next square, which halved the re-cut rate at ×1.
   */
  tick(time: JulianDate, count: number): boolean {
    if (count === 0) {
      return false;
    }
    if (Math.abs(JulianDate.secondsDifference(time, this.#tracksRefreshedAt)) < geometryRefreshSeconds(count)) {
      return false;
    }
    this.#tracksRefreshedAt = time;
    return true;
  }
}
