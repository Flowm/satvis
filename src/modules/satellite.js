import { SatelliteOrbit } from "./orbit";
//import Cesium from "cesium/Cesium";

// Import webpack externals
import Cesium from "Cesium";
import CesiumSensorVolumes from "CesiumSensorVolumes";

export class SatelliteEntity {
  constructor(viewer, tle) {
    this.viewer = viewer;

    this.name = tle.split("\n")[0];
    if (tle.startsWith("0 ")) {
      this.name = this.name.substring(2);
    }
    this.orbit = new SatelliteOrbit(tle);
    this.size = 1000;

    this.createEntities();
  }

  add(name) {
    if (typeof name !== "undefined" && name in this.entities) {
      this.viewer.entities.add(this.entities[name]);
    } else {
      for (var entity in this.entities) {
        this.viewer.entities.add(this.entities[entity]);
      }
    }
  }

  remove(name) {
    if (typeof name !== "undefined" && name in this.entities) {
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
    this.entities = {};
    this.createSatellite();
    this.createOrbitTrack();
    this.createGroundTrack();
    this.addRectangularSensor();
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

  getModelMatrix() {
    var longitude = Cesium.Math.toRadians(-90.0);
    var latitude = Cesium.Math.toRadians(30.0);
    var altitude = 3000000.0;
    var clock = 0.0;
    var cone = Cesium.Math.toRadians(15.0);
    var twist = 0.0;
    var ellipsoid = this.viewer.scene.globe.ellipsoid;
    var location = ellipsoid.cartographicToCartesian(new Cesium.Cartographic(longitude, latitude, altitude));
    var modelMatrix = Cesium.Transforms.northEastDownToFixedFrame(location);
    var orientation = Cesium.Matrix3.multiply(
      Cesium.Matrix3.multiply(Cesium.Matrix3.fromRotationZ(clock), Cesium.Matrix3.fromRotationY(cone), new Cesium.Matrix3()),
      Cesium.Matrix3.fromRotationX(twist), new Cesium.Matrix3()
    );
    return Cesium.Matrix4.multiply(modelMatrix, Cesium.Matrix4.fromRotationTranslation(orientation, Cesium.Cartesian3.ZERO), new Cesium.Matrix4());
  }

  addRectangularSensor() {
    var rectangularPyramidSensor = new CesiumSensorVolumes.RectangularPyramidSensorVolume();

    rectangularPyramidSensor.modelMatrix = this.getModelMatrix();
    rectangularPyramidSensor.radius = 20000000.0;
    rectangularPyramidSensor.xHalfAngle = Cesium.Math.toRadians(40.0);
    rectangularPyramidSensor.yHalfAngle = Cesium.Math.toRadians(20.0);

    rectangularPyramidSensor.lateralSurfaceMaterial = Cesium.Material.fromType("Color");
    rectangularPyramidSensor.lateralSurfaceMaterial.uniforms.color = new Cesium.Color(0.0, 1.0, 1.0, 0.5);
    this.viewer.scene.primitives.add(rectangularPyramidSensor);
  }
}
