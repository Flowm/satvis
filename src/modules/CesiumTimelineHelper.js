import * as Cesium from "@cesium/engine";

export class CesiumTimelineHelper {
  constructor(viewer) {
    this.viewer = viewer;
  }

  get enabled() {
    return (typeof this.viewer.timeline !== "undefined");
  }

  clearTimeline() {
    if (!this.enabled) {
      return;
    }
    // eslint-disable-next-line
    this.viewer.timeline._highlightRanges = [];
    this.viewer.timeline.updateFromClock();
    this.viewer.timeline.zoomTo(this.viewer.clock.startTime, this.viewer.clock.stopTime);
  }

  addHighlightRanges(ranges) {
    if (!this.enabled) {
      return;
    }
    ranges.forEach((range) => {
      const startJulian = Cesium.JulianDate.fromDate(new Date(range.start));
      const endJulian = Cesium.JulianDate.fromDate(new Date(range.end));
      const highlightRange = this.viewer.timeline.addHighlightRange(Cesium.Color.BLUE, 100, 0);
      highlightRange.setRange(startJulian, endJulian);
      this.viewer.timeline.updateFromClock();
      this.viewer.timeline.zoomTo(this.viewer.clock.startTime, this.viewer.clock.stopTime);
    });
  }
}
