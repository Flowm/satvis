import Cesium from "Cesium";
import Vue from "vue";
import { SatelliteManager } from "./modules/SatelliteManager";

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

const sats = new SatelliteManager(viewer);

viewer.clock.shouldAnimate = true;
Vue.prototype.viewer = viewer;
const app = new Vue({
  el: "#toolbar",
  data: {
    showSwitches: false,
    availableComponents: sats.availableComponents,
    enabledComponents: sats.enabledComponents,
  },
  watch: {
    enabledComponents: function (newComponents, oldComponents) {
      let add = newComponents.filter(x => !oldComponents.includes(x));
      for (let component of add) {
        sats.showComponent(component);
      }
      let del = oldComponents.filter(x => !newComponents.includes(x));
      for (let component of del) {
        sats.hideComponent(component);
      }
    }
  },
});

sats.addFromTle("0 First-MOVE\n1 39439U 13066Z   18203.92296999 +.00000436 +00000-0 +59983-4 0  9994\n2 39439 097.5919 229.8528 0066721 040.9363 319.6832 14.81533022250876");
sats.addFromTle("0 ISS (ZARYA)\n1 25544U 98067A   18243.71849541  .00002853  00000-0  50721-4 0  9994\n2 25544  51.6429   2.2915 0005795 114.7130 347.8859 15.53913300130267");
sats.addFromTleUrl("data/weather.txt");
