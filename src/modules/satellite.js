import Cesium from "cesium/Cesium";
import { SatelliteOrbit } from "./orbit";

export class SatelliteEntity {
  constructor(viewer, tle) {
    this.viewer = viewer;

    this.name = tle.split("\n")[0]
    if (tle.startsWith("0 ")) {
      this.name = this.name.substring(2);
    }
    this.orbit = new SatelliteOrbit(tle);
    this.size = 1000;

    this.entities = {}
    this.entities["Satellite"] = this.createSatellite();
    this.entities["OrbitTrack"] = this.createOrbitTrack();
  }

  add(name) {
    if (typeof name !== 'undefined' && name in this.entities) {
      this.viewer.entities.add(this.entities[name]);
    } else {
      for (var entity in this.entities) {
        this.viewer.entities.add(this.entities[entity]);
      }
    }
  }

  remove(name) {
    if (typeof name !== 'undefined' && name in this.entities) {
      this.viewer.entities.remove(this.entities[name]);
    } else {
      for (var entity in this.entities) {
        this.viewer.entities.remove(this.entities[entity]);
      }
    }
  }

  track() {
    this.viewer.trackedEntity = this.entities["Satellite"];
  }

  createSatellite() {
    const label = new Cesium.LabelGraphics({
      text: this.name,
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      pixelOffset: new Cesium.Cartesian2(20, 0),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(this.size * 10, 5.0e7),
      pixelOffsetScaleByDistance: new Cesium.NearFarScalar(1.0e1, 10, 2.0e5, 1),
    });

    const point = new Cesium.PointGraphics({
      pixelSize: 10,
      color: Cesium.Color.WHITE,
    });

    const box = new Cesium.BoxGraphics({
      dimensions: new Cesium.Cartesian3(this.size, this.size, this.size),
      material: Cesium.Color.WHITE,
    });


    const satellite = new Cesium.Entity({
      box: box,
      label: label,
      name: this.name,
      point: point,
      size: this.size,
      viewFrom: new Cesium.Cartesian3(0, -1200000, 1150000),
      position: new Cesium.CallbackProperty((time) => {
        const position = this.orbit.computeOrbitTrack(Cesium.JulianDate.toDate(time), 1);
        if (position.length < 3) {
          return Cesium.Cartesian3.fromRadians(0, 0, 0);
        }
        return Cesium.Cartesian3.fromRadians(position[0], position[1], position[2]);
      }, false),
    });

    return satellite;
  }

  createOrbitTrack() {
    const polyline = new Cesium.PolylineGraphics({
      width: 5,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 1,
        color: Cesium.Color.BLACK,
      }),
      positions: new Cesium.CallbackProperty((time) => {
        return Cesium.Cartesian3.fromRadiansArrayHeights(
          this.orbit.computeOrbitTrack(Cesium.JulianDate.toDate(time)));
      }, false),
    });

    const entity = new Cesium.Entity({
      polyline: polyline
    });

    return entity;
  }
}
