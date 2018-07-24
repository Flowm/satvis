window.CESIUM_BASE_URL = "./"

if (process.env.NODE_ENV === "dev") {
  require("../lib/CesiumUnminified/Cesium.js")
} else {
  require("../lib/Cesium/Cesium.js")
}

require("../lib/Cesium/Widgets/widgets.css")

var Cesium = window.Cesium

var viewer = new Cesium.Viewer("cesiumContainer")
