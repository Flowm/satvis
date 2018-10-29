import { SatelliteProperties } from "./SatelliteProperties";
import { CesiumTimelineHelper } from "./CesiumTimelineHelper";
import { CesiumEntityWrapper } from "./CesiumEntityWrapper";
import { DescriptionHelper } from "./DescriptionHelper";

// Import webpack externals
import Cesium from "Cesium";
import CesiumSensorVolumes from "CesiumSensorVolumes";

export class SatelliteEntity extends CesiumEntityWrapper {
  constructor(viewer, tle, tags) {
    super(viewer);
    this.timeline = new CesiumTimelineHelper(viewer);
    this.props = new SatelliteProperties(tle, tags);
  }

  enableComponent(name) {
    if (name === "Model" && !this.isTracked) {
      return;
    }
    super.enableComponent(name);
  }

  createEntities() {
    this.props.createSampledPosition(this.viewer.clock, sampledPosition => {
      for (var entity in this.entities) {
        this.entities[entity].position = sampledPosition;
        this.entities[entity].orientation = new Cesium.VelocityOrientationProperty(sampledPosition);
      }
      if (this.entities.hasOwnProperty("Cone")) {
        this.entities["Cone"].orientation = new Cesium.CallbackProperty((time) => {
          const position = this.props.position(time);
          const hpr = new Cesium.HeadingPitchRoll(0, Cesium.Math.toRadians(180), 0);
          return Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
        }, false);
      }
    });
    this.createDescription();

    this.entities = {};
    this.createPoint();
    this.createBox();
    this.createModel();
    this.createLabel();
    this.createOrbit();
    if (this.props.positionCartographic(this.viewer.clock.currentTime).height < 10000000) {
      this.createGroundTrack();
      this.createCone();
    }
    this.defaultEntity = this.entities["Point"];

    this.viewer.selectedEntityChanged.addEventListener(() => {
      if (this.isSelected && !this.isTracked) {
        this.updateTransits();
      }
    });
    this.viewer.trackedEntityChanged.addEventListener(() => {
      if (this.isTracked) {
        this.artificiallyTrack(
          () => { this.updateTransits(); },
          () => { this.timeline.clearTimeline(); }
        );
      }
    });
  }

  createDescription() {
    const description = new Cesium.CallbackProperty((time) => {
      const cartographic = this.props.positionCartographic(time);
      const content = DescriptionHelper.renderDescription(time, this.props.name, cartographic, this.props.transits, false);
      return content;
    });
    this.description = description;
  }

  createCesiumSatelliteEntity(entityName, entityKey, entityValue) {
    this.createCesiumEntity(entityName, entityKey, entityValue, this.props.name, this.description, this.props.sampledPosition, true);
  }

  createPoint() {
    const point = new Cesium.PointGraphics({
      pixelSize: 10,
      color: Cesium.Color.WHITE,
    });
    this.createCesiumSatelliteEntity("Point", "point", point);
  }

  createBox() {
    const size = 1000;
    const box = new Cesium.BoxGraphics({
      dimensions: new Cesium.Cartesian3(size, size, size),
      material: Cesium.Color.WHITE,
    });
    this.createCesiumSatelliteEntity("Box", "box", box);
  }

  createModel() {
    const model = new Cesium.ModelGraphics({
      uri: "./data/models/" + this.props.name + ".glb",
    });
    this.createCesiumSatelliteEntity("Model", "model", model);
  }

  createLabel() {
    const label = new Cesium.LabelGraphics({
      text: this.props.name,
      scale: 0.6,
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      pixelOffset: new Cesium.Cartesian2(15, 0),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(10000, 6.0e7),
      pixelOffsetScaleByDistance: new Cesium.NearFarScalar(1.0e1, 10, 2.0e5, 1),
    });
    this.createCesiumSatelliteEntity("Label", "label", label);
  }

  createOrbit(leadTime = 5400, trailTime = 0) {
    const path = new Cesium.PathGraphics({
      leadTime: leadTime,
      trailTime: trailTime,
      material: Cesium.Color.WHITE.withAlpha(0.2),
      resolution: 600,
      width: 5,
    });
    this.createCesiumSatelliteEntity("Orbit", "path", path);
  }

  createGroundTrack() {
    const polyline = new Cesium.PolylineGraphics({
      material: Cesium.Color.YELLOW.withAlpha(0.1),
      positions: new Cesium.CallbackProperty((time) => {
        return this.props.groundTrack(time);
      }),
      followSurface: false,
      width: 10,
    });
    this.createCesiumSatelliteEntity("Ground", "polyline", polyline);
  }

  createCone(fov = 10) {
    const cone = new Cesium.Entity({
      position: this.props.sampledPosition,
      orientation: new Cesium.CallbackProperty((time) => {
        const position = this.props.position(time);
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
      positions: new Cesium.CallbackProperty((time) => {
        const satPosition = this.props.position(time);
        const groundPosition = this.props.groundStationPosition.cartesian;
        const positions = [satPosition, groundPosition];
        return positions;
      }),
      show: new Cesium.CallbackProperty((time) => {
        return this.props.transitIntervals.contains(time);
      }),
      width: 5,
    });
    this.createCesiumSatelliteEntity("GroundStationLink", "polyline", polyline);
  }

  set groundStation(position) {
    // No groundstation calculation for GEO satellites
    if (this.props.positionCartographic(this.viewer.clock.currentTime).height > 10000000) {
      return;
    }

    this.props.groundStationPosition = position;
    this.props.clearTransits();
    if (this.isTracked) {
      this.timeline.clearTimeline();
      this.updateTransits();
    }
    this.createGroundStationLink();
  }

  updateTransits() {
    this.props.updateTransits(this.viewer.clock.currentTime, () => {
      if (this.isTracked) {
        this.timeline.addHighlightRanges(this.props.transits);
      }
    });
  }
}
