import { JulianDate } from "@cesium/core";
import type { Viewer } from "@cesium/widgets";

export class CesiumCallbackHelper {
  /** Fires on the tick after every `refreshRate` ticks. Returns the unsubscribe. */
  static createPeriodicTickCallback(viewer: Viewer, refreshRate: number, callback: (time: JulianDate) => void): () => void {
    let ticks = 0;
    return viewer.clock.onTick.addEventListener(() => {
      if (ticks < refreshRate) {
        ticks += 1;
        return;
      }
      callback(viewer.clock.currentTime);
      ticks = 0;
    });
  }

  /**
   * Fire every `refreshRate` seconds of *simulation* time, so a faster clock
   * fires it more often in real time. Returns the unsubscribe.
   */
  static createPeriodicTimeCallback(viewer: Viewer, refreshRate: number, callback: (time: JulianDate) => void): () => void {
    let lastUpdated = viewer.clock.currentTime;
    return viewer.clock.onTick.addEventListener(() => {
      const time = viewer.clock.currentTime;
      const delta = Math.abs(JulianDate.secondsDifference(time, lastUpdated));
      if (delta < refreshRate) {
        return;
      }
      callback(time);
      lastUpdated = time;
    });
  }

  /**
   * Fires once `refreshRate` seconds have passed in both *simulation* and real time,
   * so a fast clock fires at most once per `refreshRate` real seconds and a paused one
   * never. Returns the unsubscribe.
   */
  static createThrottledTimeCallback(viewer: Viewer, refreshRate: number, callback: (time: JulianDate) => void): () => void {
    let lastUpdated = viewer.clock.currentTime;
    let lastUpdatedMs = performance.now();
    return viewer.clock.onTick.addEventListener(() => {
      const time = viewer.clock.currentTime;
      const nowMs = performance.now();
      if (Math.abs(JulianDate.secondsDifference(time, lastUpdated)) < refreshRate || nowMs - lastUpdatedMs < refreshRate * 1000) {
        return;
      }
      callback(time);
      lastUpdated = time;
      lastUpdatedMs = nowMs;
    });
  }
}
