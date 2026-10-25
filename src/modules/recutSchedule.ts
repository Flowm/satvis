// When the orbit tracks are re-cut as simulation time passes. Cesium-free bookkeeping,
// so it is tested without a viewer; SatelliteManager asks it once per clock tick and
// does the re-cutting. The ground tracks keep their own time (GroundTrackBatch).

import { JulianDate } from "@cesium/core";

import { geometryRefreshSeconds } from "./satelliteGraphics";

/** What the schedule asks of the scene each tick. */
export interface RecutProbe {
  /** Active satellites; with none, nothing is due. */
  count: number;
  /** The orbit-track batch is still rebuilding. */
  tracksPending: boolean;
}

/**
 * The interval runs from when the last rebuild finished: measured from the request,
 * 5,000 tracks janked 8.2% of frames against 0.5%.
 */
export class RecutSchedule {
  /** Simulation time. */
  #tracksRefreshedAt: JulianDate;

  constructor(start: JulianDate) {
    this.#tracksRefreshedAt = start;
  }

  /** Whether the orbit tracks are due. Every tick: a grid makes a declined re-cut wait out the whole next square, which halved the re-cut rate at ×1. */
  tick(time: JulianDate, probe: RecutProbe): boolean {
    if (probe.count === 0) {
      return false;
    }
    if (probe.tracksPending) {
      this.#tracksRefreshedAt = time;
      return false;
    }
    if (Math.abs(JulianDate.secondsDifference(time, this.#tracksRefreshedAt)) < geometryRefreshSeconds(probe.count)) {
      return false;
    }
    this.#tracksRefreshedAt = time;
    return true;
  }
}
