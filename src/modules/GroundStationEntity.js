import * as Cesium from "Cesium/Cesium";
import dayjs from "dayjs";
import { CesiumEntityWrapper } from "./CesiumEntityWrapper";
import { DescriptionHelper } from "./DescriptionHelper";

import icon from "../assets/images/icons/dish.svg";

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
      width: 24,
      height: 24,
    });
    this.createCesiumEntity("Groundstation", "billboard", billboard, this.name, this.description, this.position.cartesian, false);
    this.defaultEntity = this.entities.Groundstation;
  }

  createDescription() {
    let cache;
    const description = new Cesium.CallbackProperty((time) => {
      // The callback property is invoked for every animation frame
      // To reduce cpu load cache description for 1s of sim time or 1000 callback invocations
      if (cache && Cesium.JulianDate.equalsEpsilon(time, cache.time, 1) && cache.usage < 1000) {
        cache.usage += 1;
        return cache.content
      }

      // Get passes and render description
      const passes = this.passes(time);
      const content = DescriptionHelper.renderDescription(time, this.name, this.position, passes, true);

      cache = {
        time,
        content,
        usage: 0,
      };

      return content;
    }, false);
    this.description = description;
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
