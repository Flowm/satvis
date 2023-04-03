import * as Cesium from "@cesium/engine";
import dayjs from "dayjs";
import { CesiumEntityWrapper } from "./CesiumEntityWrapper";
import { DescriptionHelper } from "./util/DescriptionHelper";

import icon from "../images/icons/dish.svg";

export class GroundStationEntity extends CesiumEntityWrapper {
  constructor(viewer, sats, position) {
    super(viewer);
    this.sats = sats;

    this.name = "Ground station";
    this.position = position;

    this.createEntities();
  }

  createEntities() {
    this.createDescription();
    this.createGroundStation();

    this.viewer.selectedEntityChanged.addEventListener(() => {
      if (this.isSelected) {
        this.setSelectedOnTickCallback((clock) => {
          // TODO: Update passes less frequently
          this.sats.visibleSatellites.forEach((sat) => {
            sat.props.updatePasses(clock.currentTime);
          });
        });
      }
    });
  }

  createGroundStation() {
    const billboard = new Cesium.BillboardGraphics({
      image: icon,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      scaleByDistance: new Cesium.NearFarScalar(1e2, 0.2, 4e7, 0.1),
    });
    this.createCesiumEntity("Groundstation", "billboard", billboard, this.name, this.description, this.position.cartesian, false);
    this.defaultEntity = this.entities.Groundstation;
  }

  createDescription() {
    this.description = DescriptionHelper.cachedCallbackProperty((time) => {
      const passes = this.passes(time);
      const content = DescriptionHelper.renderDescription(time, this.name, this.position, passes, true);
      return content;
    });
  }

  passes(time, deltaHours = 48) {
    let passes = [];
    // Aggregate passes from all visible satellites
    this.sats.visibleSatellites.forEach((sat) => {
      passes.push(...sat.props.passes);
    });

    // Filter passes based on time
    passes = passes.filter((pass) => dayjs(pass.start).diff(time, "hours") < deltaHours);

    // Sort passes by time
    passes = passes.sort((a, b) => a.start - b.start);
    return passes;
  }
}
