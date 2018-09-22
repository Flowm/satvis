import { SatelliteOrbit } from "./SatelliteOrbit";
import { CesiumTimelineHelper } from "./CesiumTimelineHelper";
//import Cesium from "cesium/Cesium";

// Import webpack externals
import Cesium from "Cesium";
import CesiumSensorVolumes from "CesiumSensorVolumes";

export class SatelliteEntity {
  constructor(viewer, tle) {
    this.viewer = viewer;
    this.timeline = new CesiumTimelineHelper(viewer);

    this.name = tle.split("\n")[0].trim();
    if (tle.startsWith("0 ")) {
      this.name = this.name.substring(2);
    }
    this.orbit = new SatelliteOrbit(tle, viewer.clock);
  }

  show() {
    for (var entity in this.entities) {
      this.showComponent(entity);
    }
  }

  hide() {
    for (var entity in this.entities) {
      this.hideComponent(entity);
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
      this.updateTransits();

    });
    const onTrackedEntityChangedRemovalCallback = this.viewer.trackedEntityChanged.addEventListener(() => {
      onTickEventRemovalCallback();
      onTrackedEntityChangedRemovalCallback();
      this.timeline.clearTimeline();

      // Restore default view angle if no new entity is tracked
      if (typeof this.viewer.trackedEntity === "undefined") {
        this.viewer.flyTo(this.defaultEntity, {
          offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-90.0), 1580000)
        });
      }
    });
  }

  createEntities() {
    this.orbit.createSampledPosition(sampledPosition => {
      for (var entity in this.entities) {
        this.entities[entity].position = sampledPosition;
        this.entities[entity].orientation = new Cesium.VelocityOrientationProperty(this.orbit.sampledPosition);
      }
      if (this.entities.hasOwnProperty("Cone")) {
        this.entities["Cone"].orientation = new Cesium.CallbackProperty(() => {
          const position = this.orbit.position;
          const hpr = new Cesium.HeadingPitchRoll(0, Cesium.Math.toRadians(180), 0);
          return Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
        }, false);
      }
    });
    this.createDesciption();

    this.entities = {};
    this.createPoint();
    this.createBox();
    this.createModel();
    this.createLabel();
    this.createOrbit();
    if (this.orbit.height < 10000000) {
      this.createGroundTrack();
      this.createCone();
    }
    this.defaultEntity = this.entities["Point"];

    this.viewer.trackedEntityChanged.addEventListener(() => {
      if (this.isTracked) {
        this.timeline.clearInterval();
        this.artificiallyTrack();
      }
    });
  }

  createCesiumEntity(name, key, value) {
    const entity = new Cesium.Entity({
      name: this.name,
      description: this.description,
      position: this.orbit.sampledPosition,
      orientation: new Cesium.VelocityOrientationProperty(this.orbit.sampledPosition),
      viewFrom: new Cesium.Cartesian3(0, -1200000, 1150000),
    });
    entity[key] = value;
    this.entities[name] = entity;
  }

  createDesciption() {
    const description = new Cesium.CallbackProperty((time) => {
      const positionCartesian = this.orbit.sampledPosition.getValue(time);
      const positionCartographic = Cesium.Cartographic.fromCartesian(positionCartesian);
      let content = `
        <div id="sat-description">
          <h3>Position</h3>
          <div>Latitude: ${positionCartographic.latitude.toFixed(2)}&deg</div>
          <div>Longitude: ${positionCartographic.longitude.toFixed(2)}&deg</div>
          <div>Elevation: ${(positionCartographic.height / 1000).toFixed(2)} km</div>
          ${this.orbit.renderTransits(time)}
        </div>
      `;
      return content;
    });
    this.description = description;
  }

  createPoint() {
    const point = new Cesium.PointGraphics({
      pixelSize: 10,
      color: Cesium.Color.WHITE,
    });
    this.createCesiumEntity("Point", "point", point);
  }

  createBox() {
    const size = 1000;
    const box = new Cesium.BoxGraphics({
      dimensions: new Cesium.Cartesian3(size, size, size),
      material: Cesium.Color.WHITE,
    });
    this.createCesiumEntity("Box", "box", box);
  }

  createModel() {
    const model = new Cesium.ModelGraphics({
      uri: "./data/models/" + this.name + ".glb",
    });
    this.createCesiumEntity("Model", "model", model);
  }

  createLabel() {
    const label = new Cesium.LabelGraphics({
      text: this.name,
      scale: 0.6,
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      pixelOffset: new Cesium.Cartesian2(15, 0),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(10000, 6.0e7),
      pixelOffsetScaleByDistance: new Cesium.NearFarScalar(1.0e1, 10, 2.0e5, 1),
    });
    this.createCesiumEntity("Label", "label", label);
  }

  createOrbit(leadTime = 3600, trailTime = 0) {
    const path = new Cesium.PathGraphics({
      leadTime: leadTime,
      trailTime: trailTime,
      material: Cesium.Color.WHITE.withAlpha(0.2),
      resolution: 600,
      width: 5,
    });
    this.createCesiumEntity("Orbit", "path", path);
  }

  createGroundTrack() {
    const polyline = new Cesium.PolylineGraphics({
      material: Cesium.Color.YELLOW.withAlpha(0.1),
      positions: new Cesium.CallbackProperty((time) => {
        return this.orbit.groundTrack(time);
      }),
      followSurface: false,
      width: 10,
    });
    this.createCesiumEntity("Ground", "polyline", polyline);
  }

  createCone(fov = 10) {
    const cone = new Cesium.Entity({
      position: this.orbit.sampledPosition,
      orientation: new Cesium.CallbackProperty(() => {
        const position = this.orbit.position;
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

  createGroundStationLink() {
    const polyline = new Cesium.PolylineGraphics({
      followSurface: false,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.2,
        color: Cesium.Color.FORESTGREEN
      }),
      positions: new Cesium.CallbackProperty(() => {
        const satPosition = this.orbit.position;
        const groundPosition = this.orbit.groundStationPosition.cartesian;
        const positions = [satPosition, groundPosition];
        return positions;
      }),
      show: new Cesium.CallbackProperty((time) => {
        return this.orbit.transitIntervals.contains(time);
      }),
      width: 5,
    });
    this.createCesiumEntity("GroundStationLink", "polyline", polyline);
  }

  set groundStation(position) {
    // No groundstation calculation for GEO satellites
    if (this.orbit.height > 10000000) {
      return;
    }

    this.orbit.groundStationPosition = position;
    if (this.isTracked) {
      this.timeline.clearTimeline();
    } else {
      this.timeline.clearInterval();
    }
    this.updateTransits();
    this.createGroundStationLink();
  }

  updateTransits() {
    if (!this.timeline.updateTimelineInterval()) {
      return;
    }
    this.orbit.updateTransits(this.timeline.interval.start, this.timeline.interval.stop);
    if (this.isTracked) {
      this.timeline.addHighlightRanges(this.orbit.transits);
    }
  }
}
