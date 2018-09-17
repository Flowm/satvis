//import Cesium from "cesium/Cesium";

// Import webpack externals
import Cesium from "Cesium";

export class CesiumTimelineHelper {
  constructor(viewer) {
    this.viewer = viewer;
    this.interval = undefined;
  }

  clearInterval() {
    this.interval = undefined;
  }

  clearTimeline() {
    this.clearInterval();
    this.viewer.timeline._highlightRanges = [];
    this.viewer.timeline.updateFromClock();
    this.viewer.timeline.zoomTo(this.viewer.clock.startTime, this.viewer.clock.stopTime);
  }

  addHighlightRanges(ranges) {
    for (const range of ranges) {
      const startJulian = new Cesium.JulianDate.fromDate(new Date(range.start));
      const endJulian = new Cesium.JulianDate.fromDate(new Date(range.end));
      const highlightRange = this.viewer.timeline.addHighlightRange(Cesium.Color.BLUE, 100, 0);
      highlightRange.setRange(startJulian, endJulian);
      this.viewer.timeline.updateFromClock();
      this.viewer.timeline.zoomTo(this.viewer.clock.startTime, this.viewer.clock.stopTime);
    }
  }

  updateTimelineInterval() {
    const currentTime = this.viewer.clock.currentTime;

    // Check if still inside of current timeline
    if (typeof this.interval !== "undefined" &&
        Cesium.TimeInterval.contains(this.interval, currentTime)) {
      return false;
    }

    this.interval = new Cesium.TimeInterval({
      start: Cesium.JulianDate.addDays(currentTime, -3, Cesium.JulianDate.clone(currentTime)),
      stop: Cesium.JulianDate.addDays(currentTime, 3, Cesium.JulianDate.clone(currentTime))
    });
    return true;
  }
}
