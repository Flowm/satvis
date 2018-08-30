import Cesium from 'cesium/Cesium';
import {SatelliteOrbit} from './modules/orbit'

import "cesium/Widgets/widgets.css"
import "./css/main.css";

var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
var isLocalOnly = true;

var viewer = new Cesium.Viewer("cesiumContainer", {
  imageryProvider: isLocalOnly ?
    new Cesium.createTileMapServiceImageryProvider({
      url : Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')
    }) :
    new Cesium.ArcGisMapServerImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'
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
const satelliteTLE = "0 First-MOVE\n1 39439U 13066Z   18203.92296999 +.00000436 +00000-0 +59983-4 0  9994\n2 39439 097.5919 229.8528 0066721 040.9363 319.6832 14.81533022250876"
var satellite = new SatelliteOrbit(satelliteTLE);
function computeSatellitePosition(timestamp) {
  const position = satellite.computeOrbitTrack(Cesium.JulianDate.toDate(timestamp), 1);
  if (position.length < 3) {
    return Cesium.Cartesian3.fromRadians(0, 0, 0);
  }
  return Cesium.Cartesian3.fromRadians(position[0], position[1], position[2]);
}

// Satellite Model
const satelliteProperties = {
  name: 'MOVE-II',
  size: 10.0,
  ellipseSize: 2.8e6,
  ellipseColor: Cesium.Color.RED.withAlpha(0.15),
  viewFrom: new Cesium.Cartesian3(0, -1200000., 1150000.)
};

var satelliteLabel = new Cesium.LabelGraphics({
  text: satelliteProperties.name,
  horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
  scaleByDistance : Cesium.NearFarScalar(1.0e1, 1, 5.0e7, 0.1),
  distanceDisplayCondition: Cesium.DistanceDisplayCondition(2.0e3, 3.0e7),
  pixelOffset: Cesium.Cartesian2(10.0, 0.0),
  pixelOffsetScaleByDistance: Cesium.NearFarScalar(1.0e3, 10.0, 1.0e7, 1.0)
});

var satelliteDummy = new Cesium.BoxGraphics({
  dimensions: new Cesium.Cartesian3(satelliteProperties.size, satelliteProperties.size, satelliteProperties.size),
  outline: true,
  outlineColor: Cesium.Color.WHITE,
  outlineWidth: 5,
  material: Cesium.Color.BLACK
});

var satelliteEntity = new Cesium.Entity({
  name: satelliteProperties.name,
  box: satelliteDummy,
  size: satelliteProperties.size,
  label: satelliteLabel,
  viewFrom: satelliteProperties.viewFrom,
  position: new Cesium.CallbackProperty(computeSatellitePosition, false)
});

var satelliteEntity = viewer.entities.add(satelliteEntity);
//viewer.zoomTo(viewer.entities);
