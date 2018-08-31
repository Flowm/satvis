import Cesium from "cesium/Cesium";
import { SatelliteOrbit } from "./orbit";

export class SatelliteEntity {
  constructor(tle) {
    this.name = tle.split("\n")[0]
    if (tle.startsWith("0 ")) {
      this.name = this.name.substring(2);
    }
    this.orbit = new SatelliteOrbit(tle);
    this.size = 1000;
    this.entity = this.createSatelliteEntity();
  }

  add(viewer) {
    viewer.entities.add(this.entity);
  }

  remove(viewer) {
    viewer.entities.remove(this.entity);
  }

  track(viewer) {
    viewer.trackedEntity = this.entity;
  }

  createSatelliteEntity() {
    const satelliteLabel = new Cesium.LabelGraphics({
      text: this.name,
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      pixelOffset: new Cesium.Cartesian2(40, 0),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(this.size * 5, 5.0e7),
      pixelOffsetScaleByDistance: new Cesium.NearFarScalar(1.0e1, 10, 2.0e5, 1),
    });

    const satellitePoint = new Cesium.PointGraphics({
      pixelSize: 10,
      color: Cesium.Color.WHITE,
    });

    const satelliteBox = new Cesium.BoxGraphics({
      dimensions: new Cesium.Cartesian3(this.size, this.size, this.size),
      material: Cesium.Color.WHITE,
    });

    const satelliteEntity = new Cesium.Entity({
      name: this.name,
      point: satellitePoint,
      box: satelliteBox,
      size: this.size,
      label: satelliteLabel,
      viewFrom: new Cesium.Cartesian3(0, -1200000, 1150000),
      position: new Cesium.CallbackProperty((timestamp) => {
        const position = this.orbit.computeOrbitTrack(Cesium.JulianDate.toDate(timestamp), 1);
        if (position.length < 3) {
          return Cesium.Cartesian3.fromRadians(0, 0, 0);
        }
        return Cesium.Cartesian3.fromRadians(position[0], position[1], position[2]);
      }, false),
    });

    return satelliteEntity;
  }
}
