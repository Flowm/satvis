// When the orbit tracks and the ground-track corridors are re-cut as simulation time
// passes. Cesium-free bookkeeping, so it is tested without a viewer; SatelliteManager
// asks it once per clock tick and does the re-cutting.

import { JulianDate } from "@cesium/core";

import { geometryRefreshSeconds } from "./satelliteGraphics";

/**
 * Clock ticks between corridor re-cuts when no satellite can say whether the batch has
 * settled. Cesium rebuilds the corridor batch asynchronously and a re-cut before the
 * last one lands discards it, so re-cutting faster than the rebuild freezes the ground
 * track. The rebuild measured 4 frames at 50 corridors and 25 at 1,500.
 */
const GROUND_TRACK_REFRESH_FRAMES = 30;

/** What the schedule asks of the scene each tick. */
export interface RecutProbe {
  /** Active satellites; with none, nothing is due. */
  count: number;
  /** The orbit-track batch is still rebuilding. */
  tracksPending: boolean;
  /**
   * Whether the corridors have caught up with their last positions; undefined when no
   * satellite can answer. Asked only while a re-cut is in flight.
   */
  groundTracksSettled(): boolean | undefined;
}

/** Which batches to re-cut on this tick. */
interface RecutsDue {
  tracks: boolean;
  groundTracks: boolean;
}

/**
 * The interval runs from when the last rebuild finished: measured from the request,
 * 5,000 tracks janked 8.2% of frames against 0.5%. The orbit batch waits on `pending`
 * and the corridors on `groundTracksSettled`; sharing `pending` starved the corridors
 * to one re-cut in 7.5 s.
 */
export class RecutSchedule {
  /** Simulation time. */
  #tracksRefreshedAt: JulianDate;

  /** Simulation time. */
  #groundTracksRefreshedAt: JulianDate;

  /** Clock ticks, not rendered frames. */
  #frames = 0;

  #groundTracksRefreshedOnFrame = 0;

  /**
   * Undefined while the re-cut is in flight. Starts landed so a scene's first corridors do not wait.
   */
  #groundTracksLandedOnFrame: number | undefined = 0;

  constructor(start: JulianDate) {
    this.#tracksRefreshedAt = start;
    this.#groundTracksRefreshedAt = start;
  }

  /** One clock tick, every tick: a grid makes a declined re-cut wait out the whole next square, which halved the re-cut rate at ×1. */
  tick(time: JulianDate, probe: RecutProbe): RecutsDue {
    this.#frames += 1;
    if (probe.count === 0) {
      return { tracks: false, groundTracks: false };
    }
    const due = geometryRefreshSeconds(probe.count);
    const stale = (since: JulianDate): boolean => Math.abs(JulianDate.secondsDifference(time, since)) >= due;

    if (probe.tracksPending) {
      this.#tracksRefreshedAt = time;
    }
    const tracks = !probe.tracksPending && stale(this.#tracksRefreshedAt);
    // Asked every tick, not only once stale: it records the tick the rebuild landed on,
    // and a late first look would overstate the rebuild and stretch the wait.
    const groundTracks = this.#groundTracksRested(probe) && stale(this.#groundTracksRefreshedAt);
    if (tracks) {
      this.#tracksRefreshedAt = time;
    }
    if (groundTracks) {
      this.#groundTracksRefreshedAt = time;
      this.#groundTracksRefreshedOnFrame = this.#frames;
      this.#groundTracksLandedOnFrame = undefined;
    }
    return { tracks, groundTracks };
  }

  /**
   * Whether the last re-cut has landed and then stayed idle for as long again.
   * Re-cutting the instant one lands measured 6 fps at 1,542 corridors and
   * ×1000; this rule measured 46 fps. In frames, not milliseconds, so the
   * interval stretches as the frame rate falls.
   */
  #groundTracksRested(probe: RecutProbe): boolean {
    if (this.#groundTracksLandedOnFrame === undefined) {
      const settled = probe.groundTracksSettled() ?? this.#frames - this.#groundTracksRefreshedOnFrame >= GROUND_TRACK_REFRESH_FRAMES;
      if (!settled) {
        return false;
      }
      this.#groundTracksLandedOnFrame = this.#frames;
    }
    const rebuild = this.#groundTracksLandedOnFrame - this.#groundTracksRefreshedOnFrame;
    return this.#frames - this.#groundTracksRefreshedOnFrame >= 2 * rebuild;
  }
}
