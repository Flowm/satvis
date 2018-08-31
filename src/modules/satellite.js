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

    this.createEntities();
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

  createEntities() {
    this.entities = {}
    this.createSatellite();
    this.createOrbitTrack();
    this.createGroundTrack();
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


    this.entities["Satellite"] = new Cesium.Entity({
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
  }

  createOrbitTrack() {
    const polyline = new Cesium.PolylineGraphics({
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 1,
        color: Cesium.Color.BLACK,
      }),
      positions: new Cesium.CallbackProperty((time) => {
        return Cesium.Cartesian3.fromRadiansArrayHeights(
          this.orbit.computeOrbitTrack(Cesium.JulianDate.toDate(time)));
      }, false),
      width: 5,
    });

    this.entities["OrbitTrack"] = new Cesium.Entity({
      polyline: polyline
    });
  }

  createGroundTrack() {
    const polyline = new Cesium.PolylineGraphics({
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 1,
        color: Cesium.Color.RED,
      }),
      positions: new Cesium.CallbackProperty((time) => {
        const orbitTrackPositions = this.orbit.computeOrbitTrack(Cesium.JulianDate.toDate(time));
        const groundTrackPositions = [];
        for (let i = 0; i < orbitTrackPositions.length; i++) {
          if ((i + 1) % 3 === 0) {
            groundTrackPositions[i] = 0;
          } else {
            groundTrackPositions[i] = orbitTrackPositions[i];
          }
        }
        return Cesium.Cartesian3.fromRadiansArrayHeights(groundTrackPositions);
      }, false),
      width: 5,
    });

    this.entities["GroundTrack"] = new Cesium.Entity({
      polyline: polyline
    });
  }
}
