import { CesiumController } from "./modules/CesiumController";
import { SatelliteManager } from "./modules/SatelliteManager";
import Vue from "vue";

import "cesium/Widgets/widgets.css";
import "./css/main.css";

const cc = new CesiumController();
const sats = new SatelliteManager(cc.viewer);
Vue.prototype.cc = cc;
Vue.prototype.sats = sats;

const app = new Vue({
  el: "#toolbar",
  data: {
    menu: {
      sat: false,
      env: false,
      ios: false,
      dbg: false,
    },
    isIOS: cc.isIOS,
    availableComponents: sats.availableComponents,
    enabledComponents: sats.enabledComponents,
    availableImageryProviders: cc.imageryProviders,
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

sats.addFromTle("EVE-1\n1 39439U 13066Z   18203.92296999 +.00000436 +00000-0 +59983-4 0  9994\n2 39439 097.5919 229.8528 0066721 040.9363 319.6832 14.81533022250876");
sats.addFromTle("ISS\n1 25544U 98067A   18257.91439815  .00001783  00000-0  34518-4 0  9997\n2 25544  51.6414 291.5521 0005015 157.3801 208.5555 15.53849779132479");
sats.addFromTleUrl("data/tle/weather.txt");
//sats.addFromTleUrl("data/tle/resource.txt");
//sats.addFromTleUrl("data/tle/science.txt");
sats.getSatellite("ISS").track();
