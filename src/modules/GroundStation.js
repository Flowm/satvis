//import Cesium from "cesium/Cesium";
// Import webpack externals
import Cesium from "Cesium";

export class GroundStation {
  constructor(viewer) {
    this.viewer = viewer;
    this.entities = {};
    this.pickerEnabled = false;
  }

  get available() {
    return (typeof this.groundStation !== "undefined");
  }

  update(position) {
    if (!this.pickerEnabled) {
      return;
    }
    if (this.available) {
      this.viewer.entities.remove(this.groundStation);
    }

    this.position = Cesium.Cartesian3.fromDegrees(position.lon, position.lat);
    this.latlonalt = [position.lat, position.lon, position.height/1000];
    this.groundStation = {
      id: "Groundstation",
      name: "Groundstation",
      position: this.position,
      billboard: {
        image: require("../../node_modules/cesium/Build/Apps/Sandcastle/images/facility.gif"),
      }
    };
    this.viewer.entities.add(this.groundStation);
  }
}
