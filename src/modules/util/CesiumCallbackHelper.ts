import { JulianDate } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

// Use `any` for Cesium viewer/event - tightening Cesium types is out of scope.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CesiumEvent = any;

export class CesiumCallbackHelper {
  /**
   * Fire every `refreshRate` ticks of the clock.
   * @returns the unsubscribe
   */
  static createPeriodicTickCallback(viewer: Viewer, refreshRate: number, callback: (time: JulianDate) => void, event: CesiumEvent = viewer.clock.onTick): () => void {
    let ticks = 0;
    return event.addEventListener(() => {
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
   * fires it more often in real time.
   * @returns the unsubscribe
   */
  static createPeriodicTimeCallback(viewer: Viewer, refreshRate: number, callback: (time: JulianDate) => void, event: CesiumEvent = viewer.clock.onTick): () => void {
    let lastUpdated = viewer.clock.currentTime;
    return event.addEventListener(() => {
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
   * Fire once `refreshRate` seconds have passed in both *simulation* and real
   * time: as often as the periodic time callback at 1×, but no more than once per
   * `refreshRate` real seconds at a faster clock, and not at all while it is paused.
   * @returns the unsubscribe
   */
  static createThrottledTimeCallback(viewer: Viewer, refreshRate: number, callback: (time: JulianDate) => void, event: CesiumEvent = viewer.clock.onTick): () => void {
    let lastUpdated = viewer.clock.currentTime;
    let lastUpdatedMs = performance.now();
    return event.addEventListener(() => {
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
