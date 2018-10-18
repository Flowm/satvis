import { SatelliteOrbit } from "./SatelliteOrbit";
import { CesiumEntityWrapper } from "./CesiumEntityWrapper";

// Import webpack externals
import Cesium from "Cesium";

export class GroundStationEntity extends CesiumEntityWrapper {
  constructor(viewer, position) {
    super(viewer);
    this.name = "Ground station"
    this.description = ""
    this.createGroundStation(position);
  }

  createGroundStation(position) {
    const billboard = new Cesium.BillboardGraphics({
      image: require("../assets/images/icons/dish.svg"),
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      width: 24,
      height: 24,
    });
    this.createCesiumEntity("Groundstation", "billboard", billboard, position, false);
    this.defaultEntity = this.entities["Groundstation"];
  }
}
