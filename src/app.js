window.CESIUM_BASE_URL = "./"

if (process.env.NODE_ENV === "dev") {
  require("../lib/CesiumUnminified/Cesium.js")
} else {
  require("../lib/Cesium/Cesium.js")
}

require("../lib/Cesium/Widgets/widgets.css")
require('./css/main.css');

var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
var isLocalOnly = true;

var Cesium = window.Cesium

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
