import Cesium from "cesium/Cesium";
import { SatelliteOrbit } from "./modules/orbit";

import "cesium/Widgets/widgets.css";
import "./css/main.css";

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isLocalOnly = true;

const viewer = new Cesium.Viewer("cesiumContainer", {
  imageryProvider: isLocalOnly
    ? new Cesium.createTileMapServiceImageryProvider({
      url: Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
    })
    : new Cesium.ArcGisMapServerImageryProvider({
      url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
    }),
  baseLayerPicker: !isLocalOnly,
  animation: !isIOS,
  geocoder: false,
  timeline: !isIOS,
  vrButton: true,
  fullscreenButton: !isIOS,
  fullscreenElement: document.body,
  navigationInstructionsInitiallyVisible: false,
});

viewer.scene.globe.enableLighting = false;
viewer.scene.fog.enabled = false;
viewer.scene.debugShowFramesPerSecond = true;

// Satellite Position
const satelliteTLE = "0 First-MOVE\n1 39439U 13066Z   18203.92296999 +.00000436 +00000-0 +59983-4 0  9994\n2 39439 097.5919 229.8528 0066721 040.9363 319.6832 14.81533022250876";
const satellite = new SatelliteOrbit(satelliteTLE);
function computeSatellitePosition(timestamp) {
  const position = satellite.computeOrbitTrack(Cesium.JulianDate.toDate(timestamp), 1);
  if (position.length < 3) {
    return Cesium.Cartesian3.fromRadians(0, 0, 0);
  }
  return Cesium.Cartesian3.fromRadians(position[0], position[1], position[2]);
}

// Satellite Model
const satelliteProperties = {
  name: "MOVE-II",
  size: 1000.0,
  viewFrom: new Cesium.Cartesian3(0, -1200000, 1150000),
};

const satelliteLabel = new Cesium.LabelGraphics({
  text: satelliteProperties.name,
  horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
  pixelOffset: new Cesium.Cartesian2(10, 0),
  distanceDisplayCondition: new Cesium.DistanceDisplayCondition(satelliteProperties.size * 5, 5.0e7),
  pixelOffsetScaleByDistance: new Cesium.NearFarScalar(satelliteProperties.size, 50, 2.0e5, 1),
});

const satellitePoint = new Cesium.PointGraphics({
  pixelSize: 10,
  color: Cesium.Color.WHITE,
});

const satelliteDummy = new Cesium.BoxGraphics({
  dimensions: new Cesium.Cartesian3(satelliteProperties.size, satelliteProperties.size, satelliteProperties.size),
  material: Cesium.Color.WHITE,
});

const satelliteEntity = new Cesium.Entity({
  name: satelliteProperties.name,
  point: satellitePoint,
  box: satelliteDummy,
  size: satelliteProperties.size,
  label: satelliteLabel,
  viewFrom: satelliteProperties.viewFrom,
  position: new Cesium.CallbackProperty(computeSatellitePosition, false),
});

viewer.entities.add(satelliteEntity);
viewer.trackedEntity = satelliteEntity;
