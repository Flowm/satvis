import * as Cesium from "@cesium/engine";
import CesiumSensorVolumes from "cesium-sensor-volumes";
import { SatelliteProperties } from "./SatelliteProperties";
import { CesiumTimelineHelper } from "./CesiumTimelineHelper";
import { CesiumEntityWrapper } from "./CesiumEntityWrapper";
import { DescriptionHelper } from "./DescriptionHelper";

export class SatelliteEntityWrapper extends CesiumEntityWrapper {
  constructor(viewer, tle, tags) {
    super(viewer);
    this.props = new SatelliteProperties(tle, tags);
  }

  enableComponent(name) {
    if (!this.created) {
      this.createEntities();
    }
    if (name === "3D model") {
      // Adjust label offset to avoid overlap with model
      this.entities.Label.label.pixelOffset = new Cesium.Cartesian2(20, 0);
    }
    super.enableComponent(name);
  }

  disableComponent(name) {
    if (name === "3D model") {
      // Restore old label offset
      this.entities.Label.label.pixelOffset = new Cesium.Cartesian2(10, 0);
    }
    super.disableComponent(name);
  }

  createEntities() {
    this.createDescription();

    this.entities = {};
    this.createPoint();
    // this.createBox();
    this.createLabel();
    this.createOrbit();
    this.createOrbitTrack();
    if (this.props.orbit.orbitalPeriod < 60 * 2) {
      // Ground track and cone graphic are optimized for LEO satellites
      this.createGroundTrack();
      this.createCone();
    }
    this.createModel();
    if (this.props.groundStationAvailable) {
      this.createGroundStationLink();
    }
    this.defaultEntity = this.entities.Point;

    // Add sampled position to all entities
    this.props.createSampledPosition(this.viewer.clock, (sampledPosition, sampledPositionInertial) => {
      Object.entries(this.entities).forEach(([type, entity]) => {
        if (type === "Orbit") {
          entity.position = sampledPositionInertial;
        } else if (type === "SensorCone") {
          entity.position = sampledPosition;
          entity.orientation = new Cesium.CallbackProperty((time) => {
            const position = this.props.position(time);
            const hpr = new Cesium.HeadingPitchRoll(0, Cesium.Math.toRadians(180), 0);
            return Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
          }, false);
        } else {
          entity.position = sampledPosition;
          entity.orientation = new Cesium.VelocityOrientationProperty(sampledPosition);
        }
      });
    });

    // Set up event listeners
    this.viewer.selectedEntityChanged.addEventListener((entity) => {
      if (!entity || entity?.name === "Ground station") {
        CesiumTimelineHelper.clearHighlightRanges(this.viewer);
        return;
      }
      if (this.isSelected) {
        this.props.updatePasses(this.viewer.clock.currentTime);
        CesiumTimelineHelper.updateHighlightRanges(this.viewer, this.props.passes);
      }
    });

    this.viewer.trackedEntityChanged.addEventListener(() => {
      if (this.isTracked) {
        this.artificiallyTrack();
      }
    });
  }

  createDescription() {
    this.description = DescriptionHelper.cachedCallbackProperty((time) => {
      const cartographic = this.props.orbit.positionGeodetic(Cesium.JulianDate.toDate(time), true);
      const content = DescriptionHelper.renderDescription(time, this.props.name, cartographic, this.props.passes, false, this.props.orbit.tle);
      return content;
    });
  }

  createCesiumSatelliteEntity(entityName, entityKey, entityValue) {
    this.createCesiumEntity(entityName, entityKey, entityValue, this.props.name, this.description, this.props.sampledPosition, true);
  }

  createPoint() {
    const point = new Cesium.PointGraphics({
      pixelSize: 6,
      color: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.DIMGREY,
      outlineWidth: 1,
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
      uri: `./data/models/${this.props.name.split(" ").join("-")}.glb`,
      minimumPixelSize: 50,
      maximumScale: 10000,
    });
    this.createCesiumSatelliteEntity("3D model", "model", model);
  }

  createLabel() {
    const label = new Cesium.LabelGraphics({
      text: this.props.name,
      font: "15px Arial",
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      outlineColor: Cesium.Color.DIMGREY,
      outlineWidth: 2,
      horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
      pixelOffset: new Cesium.Cartesian2(10, 0),
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(2000, 8e7),
      translucencyByDistance: new Cesium.NearFarScalar(6e7, 1.0, 8e7, 0.0),
    });
    this.createCesiumSatelliteEntity("Label", "label", label);
  }

  createOrbit() {
    const path = new Cesium.PathGraphics({
      leadTime: (this.props.orbit.orbitalPeriod * 60) / 2 + 5,
      trailTime: (this.props.orbit.orbitalPeriod * 60) / 2 + 5,
      material: Cesium.Color.WHITE.withAlpha(0.15),
      resolution: 600,
      width: 2,
    });
    this.createCesiumEntity("Orbit", "path", path, this.props.name, this.description, this.props.sampledPositionInertial, true);
  }

  createOrbitTrack(leadTime = this.props.orbit.orbitalPeriod * 60, trailTime = 0) {
    const path = new Cesium.PathGraphics({
      leadTime,
      trailTime,
      material: Cesium.Color.GOLD.withAlpha(0.15),
      resolution: 600,
      width: 2,
    });
    this.createCesiumSatelliteEntity("Orbit track", "path", path);
  }

  createGroundTrack(width = 165) {
    const corridor = new Cesium.CorridorGraphics({
      cornerType: Cesium.CornerType.MITERED,
      material: Cesium.Color.ORANGE.withAlpha(0.2),
      positions: new Cesium.CallbackProperty((time) => this.props.groundTrack(time), false),
      width: width * 1000,
    });
    this.createCesiumSatelliteEntity("Ground track", "corridor", corridor);
  }

  createCone(fov = 10) {
    const cone = new Cesium.Entity();
    cone.addProperty("conicSensor");
    cone.conicSensor = new CesiumSensorVolumes.ConicSensorGraphics({
      radius: 1000000,
      innerHalfAngle: Cesium.Math.toRadians(0),
      outerHalfAngle: Cesium.Math.toRadians(fov),
      lateralSurfaceMaterial: Cesium.Color.GOLD.withAlpha(0.15),
      intersectionColor: Cesium.Color.GOLD.withAlpha(0.3),
      intersectionWidth: 1,
    });
    this.entities.SensorCone = cone;
  }

  createGroundStationLink() {
    const polyline = new Cesium.PolylineGraphics({
      followSurface: false,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.5,
        color: Cesium.Color.FORESTGREEN,
      }),
      positions: new Cesium.CallbackProperty((time) => {
        const satPosition = this.props.position(time);
        const groundPosition = this.props.groundStationPosition.cartesian;
        const positions = [satPosition, groundPosition];
        return positions;
      }, false),
      show: new Cesium.CallbackProperty((time) => this.props.passIntervals.contains(time), false),
      width: 5,
    });
    this.createCesiumSatelliteEntity("Ground station link", "polyline", polyline);
  }

  set groundStation(position) {
    // No groundstation calculation for GEO satellites
    if (this.props.orbit.orbitalPeriod > 60 * 12) {
      return;
    }

    this.props.groundStationPosition = position;
    this.props.clearPasses();
    if (this.isSelected || this.isTracked) {
      this.props.updatePasses(this.viewer.clock.currentTime);
      if (this.isSelected) {
        CesiumTimelineHelper.updateHighlightRanges(this.viewer, this.props.passes);
      }
    }
    if (this.created) {
      this.createGroundStationLink();
    }
  }
}
