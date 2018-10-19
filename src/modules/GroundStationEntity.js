import { SatelliteOrbit } from "./SatelliteOrbit";
import { CesiumEntityWrapper } from "./CesiumEntityWrapper";
import { DescriptionHelper } from "./DescriptionHelper";

// Import webpack externals
import Cesium from "Cesium";

export class GroundStationEntity extends CesiumEntityWrapper {
  constructor(viewer, position) {
    super(viewer);
    this.name = "Ground station"
    this.position = position;

    this.createEntities();
  }

  createEntities() {
    this.createDescription();
    this.createGroundStation();
  }

  createGroundStation() {
    const billboard = new Cesium.BillboardGraphics({
      image: require("../assets/images/icons/dish.svg"),
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      width: 24,
      height: 24,
    });
    this.createCesiumEntity("Groundstation", "billboard", billboard, this.position.cartesian, false);
    this.defaultEntity = this.entities["Groundstation"];
  }

  createDescription() {
    const description = new Cesium.CallbackProperty((time) => {
      const content = DescriptionHelper.renderSatelliteDescription(time, this.name, this.position, []);
      return content;
    });
    this.description = description;
  }
}
