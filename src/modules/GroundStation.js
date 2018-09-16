//import Cesium from "cesium/Cesium";
// Import webpack externals
import Cesium from "Cesium";

export class GroundStation {
  constructor(viewer) {
    this.viewer = viewer;
    this.entities = {};
    this.pickerEnabled = false;
  }

  update(position) {
    if (!this.pickerEnabled) {
      return;
    }
    if (typeof this.groundStation !== "undefined") {
      this.viewer.entities.remove(this.groundStation);
    }

    this.groundStation = {
      id: "Groundstation",
      name: "Groundstation",
      position: Cesium.Cartesian3.fromDegrees(position.lon, position.lat),
      billboard: {
        image: require("../../node_modules/cesium/Build/Apps/Sandcastle/images/facility.gif"),
      }
    };
    this.viewer.entities.add(this.groundStation);
  }
}
