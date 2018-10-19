import { SatelliteProperties } from "./SatelliteProperties";
import { CesiumTimelineHelper } from "./CesiumTimelineHelper";
import { CesiumEntityWrapper } from "./CesiumEntityWrapper";
import { DescriptionHelper } from "./DescriptionHelper";

// Import webpack externals
import Cesium from "Cesium";
import CesiumSensorVolumes from "CesiumSensorVolumes";

export class SatelliteEntity extends CesiumEntityWrapper {
  constructor(viewer, tle) {
    super(viewer);
    this.timeline = new CesiumTimelineHelper(viewer);
    this.props = new SatelliteProperties(viewer.clock, tle);
  }

  createEntities() {
    this.props.createSampledPosition(sampledPosition => {
      for (var entity in this.entities) {
        this.entities[entity].position = sampledPosition;
        this.entities[entity].orientation = new Cesium.VelocityOrientationProperty(this.props.sampledPosition);
      }
      if (this.entities.hasOwnProperty("Cone")) {
        this.entities["Cone"].orientation = new Cesium.CallbackProperty(() => {
          const position = this.props.position;
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
    if (this.props.height < 10000000) {
      this.createGroundTrack();
      this.createCone();
    }
    this.defaultEntity = this.entities["Point"];

    this.viewer.trackedEntityChanged.addEventListener(() => {
      if (this.isTracked) {
        this.timeline.clearInterval();
        this.artificiallyTrack(
          () => { this.updateTransits(); },
          () => { this.timeline.clearTimeline(); }
        );
      }
    });
  }

  createDescription() {
    const description = new Cesium.CallbackProperty((time) => {
      const positionCartesian = this.props.sampledPosition.getValue(time);
      const positionCartographic = Cesium.Cartographic.fromCartesian(positionCartesian);
      const content = DescriptionHelper.renderDescription(time, this.props.name, positionCartographic, this.props.transits);
      return content;
    });
    this.description = description;
  }

  createCesiumSatelliteEntity(entityName, entityKey, entityValue) {
    this.createCesiumEntity(entityName, entityKey, entityValue, this.props.name, this.description, this.props.sampledPosition, true)
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

  createOrbit(leadTime = 3600, trailTime = 0) {
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
      orientation: new Cesium.CallbackProperty(() => {
        const position = this.props.position;
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
        const satPosition = this.props.position;
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
    if (this.props.height > 10000000) {
      return;
    }

    this.props.groundStationPosition = position;
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
    this.props.updateTransits(this.timeline.interval.start, this.timeline.interval.stop);
    if (this.isTracked) {
      this.timeline.addHighlightRanges(this.props.transits);
    }
  }
}
