import { SatelliteOrbit } from "./SatelliteOrbit";
//import Cesium from "cesium/Cesium";

// Import webpack externals
import Cesium from "Cesium";
import CesiumSensorVolumes from "CesiumSensorVolumes";

export class SatelliteEntity {
  constructor(viewer, tle) {
    this.viewer = viewer;

    this.name = tle.split("\n")[0].trim();
    if (tle.startsWith("0 ")) {
      this.name = this.name.substring(2);
    }
    this.orbit = new SatelliteOrbit(tle);
    this.size = 1000;

    this.createSampledPosition();
    this.createEntities();
  }

  show() {
    for (var entity in this.entities) {
      this.showComponent(entity);
    }
  }

  get components() {
    return Object.keys(this.entities);
  }

  showComponent(name) {
    if (typeof name === "undefined") {
      return;
    }
    if (name in this.entities && ! this.viewer.entities.contains(this.entities[name])) {
      this.viewer.entities.add(this.entities[name]);
    }
  }

  hide() {
    for (var entity in this.entities) {
      this.hideComponent(entity);
    }
  }

  hideComponent(name) {
    if (typeof name === "undefined") {
      return;
    }
    if (name in this.entities && this.viewer.entities.contains(this.entities[name])) {
      this.viewer.entities.remove(this.entities[name]);
    }
  }

  track(animate = false) {
    if (typeof this.defaultEntity === "undefined") {
      return;
    }
    if (!animate) {
      this.viewer.trackedEntity = this.defaultEntity;
      return;
    }

    this.viewer.trackedEntity = undefined;
    const clockRunning = this.viewer.clock.shouldAnimate;
    this.viewer.clock.shouldAnimate = false;

    this.viewer.flyTo(this.defaultEntity, {
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_FOUR, 1580000)
    }).then((result) => {
      if (result) {
        this.viewer.trackedEntity = this.defaultEntity;
        this.viewer.clock.shouldAnimate = clockRunning;
      }
    });
  }

  get isTracked() {
    return this.viewer.trackedEntity === this.defaultEntity;
  }

  artificiallyTrack() {
    const cameraTracker = new Cesium.EntityView(this.defaultEntity, this.viewer.scene, this.viewer.scene.globe.ellipsoid);

    const onTickEventRemovalCallback = this.viewer.clock.onTick.addEventListener((clock) => {
      cameraTracker.update(clock.currentTime);
    });
    const onTrackedEntityChangedRemovalCallback = this.viewer.trackedEntityChanged.addEventListener(() => {
      onTickEventRemovalCallback();
      onTrackedEntityChangedRemovalCallback();

      // Restore default view angle if no new entity is tracked
      if (typeof this.viewer.trackedEntity === "undefined") {
        this.viewer.flyTo(this.defaultEntity, {
          offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-90.0), 1580000)
        });
      }
    });
  }

  createSampledPosition() {
    let lastUpdated;
    [this.position, lastUpdated] = this.orbit.computeSampledPosition(this.viewer.clock.currentTime)
    this.viewer.clock.onTick.addEventListener((clock) => {
      const dt = Math.abs(Cesium.JulianDate.secondsDifference(clock.currentTime, lastUpdated));
      if (dt >= 60 * 15) {
        [this.position, lastUpdated] = this.orbit.computeSampledPosition(clock.currentTime)
        for (var entity in this.entities) {
          this.entities[entity].position = this.position;
        }
      }
    });
  }

  createEntities() {
    this.entities = {};
    this.createPoint();
    this.createBox();
    this.createModel();
    this.createLabel();
    this.createOrbit();
    this.createGround();
    this.createCone();

    this.viewer.trackedEntityChanged.addEventListener(() => {
      if (this.isTracked) {
        this.artificiallyTrack();
      }
    });
  }

  createPoint() {
    const point = new Cesium.PointGraphics({
      pixelSize: 10,
      color: Cesium.Color.WHITE,
    });

    this.entities["Point"] = new Cesium.Entity({
      point: point,
      name: this.name,
      position: this.position,
      orientation: new Cesium.VelocityOrientationProperty(this.position),
      viewFrom: new Cesium.Cartesian3(0, -1200000, 1150000),
    });
    this.defaultEntity = this.entities["Point"];
  }

  createBox() {
    const box = new Cesium.BoxGraphics({
      dimensions: new Cesium.Cartesian3(this.size, this.size, this.size),
      material: Cesium.Color.WHITE,
    });

    this.entities["Box"] = new Cesium.Entity({
      box: box,
      name: this.name,
      position: this.position,
      orientation: new Cesium.VelocityOrientationProperty(this.position),
      viewFrom: new Cesium.Cartesian3(0, -1200000, 1150000),
    });
  }

  createModel() {
    const path = "./data/models/" + this.name + ".glb";
    const model = new Cesium.ModelGraphics({
      uri: path,
    });

    this.entities["Model"] = new Cesium.Entity({
      model: model,
      name: this.name,
      position: this.position,
      orientation: new Cesium.VelocityOrientationProperty(this.position),
      viewFrom: new Cesium.Cartesian3(0, -1200000, 1150000),
    });
  }

  createLabel() {
    const label = new Cesium.LabelGraphics({
      text: this.name,
      scale: 0.6,
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      pixelOffset: new Cesium.Cartesian2(15, 0),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(this.size * 10, 6.0e7),
      pixelOffsetScaleByDistance: new Cesium.NearFarScalar(1.0e1, 10, 2.0e5, 1),
    });

    this.entities["Label"] = new Cesium.Entity({
      label: label,
      name: this.name,
      position: this.position,
      orientation: new Cesium.VelocityOrientationProperty(this.position),
      viewFrom: new Cesium.Cartesian3(0, -1200000, 1150000),
    });
  }

  createOrbit(leadTime = 3600, trailTime = 0) {
    const path = new Cesium.PathGraphics({
      leadTime: leadTime,
      trailTime: trailTime,
      material: Cesium.Color.WHITE.withAlpha(0.2),
      resolution: 600,
      width: 5,
    });

    this.entities["Orbit"] = new Cesium.Entity({
      path: path,
      position: this.position,
    });
  }

  createGround() {
    const polyline = new Cesium.PolylineGraphics({
      material: Cesium.Color.YELLOW.withAlpha(0.1),
      positions: new Cesium.CallbackProperty((time) => {
        const orbitTrackPositions = this.orbit.computeOrbitTrack(time);
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
      width: 10,
    });

    this.entities["Ground"] = new Cesium.Entity({
      polyline: polyline
    });
  }

  createCone(fov = 10) {
    const cone = new Cesium.Entity({
      position: this.position,
      orientation: new Cesium.CallbackProperty((time) => {
        const position = this.orbit.computePositionCartesian3(time);
        const hpr = new Cesium.HeadingPitchRoll(0, Cesium.Math.toRadians(180), 0);
        return Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
      }, false),
    });

    cone.addProperty("conicSensor");
    cone.conicSensor = new CesiumSensorVolumes.ConicSensorGraphics({
      radius: 10000000,
      innerHalfAngle: Cesium.Math.toRadians(0),
      outerHalfAngle: Cesium.Math.toRadians(fov),
      lateralSurfaceMaterial: Cesium.Color.GOLD.withAlpha(0.15),
      intersectionColor: Cesium.Color.GOLD.withAlpha(0.3),
      intersectionWidth: 1,
    });
    this.entities["Cone"] = cone;
  }
}
