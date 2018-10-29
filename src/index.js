import { ServiceWorkerManager } from "./modules/ServiceWorkerManager";
ServiceWorkerManager.registerAndUpdate();

import Vue from "vue";
import Buefy from "buefy";
import SatelliteSelect from "./components/SatelliteSelect.vue";
import SatelliteMultiSelect from "./components/SatelliteMultiSelect.vue";
import SatelliteNotifyMultiSelect from "./components/SatelliteNotifyMultiSelect.vue";
import VueCesiumController from "./components/VueCesiumController.js";
Vue.use(Buefy);
Vue.use(VueCesiumController);

import "buefy/dist/buefy.css";
import "cesium/Widgets/widgets.css";
import "./css/main.css";

// Font awesome setup
import { library, dom } from "@fortawesome/fontawesome-svg-core";
import { faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faRedo, faBell } from "@fortawesome/free-solid-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";
library.add(faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faRedo, faBell, faGithub);
dom.watch();

/* global cc */
const app = new Vue({
  el: "#toolbar",
  components: {
    "satellite-select": SatelliteSelect,
    "satellite-multi-select": SatelliteMultiSelect,
    "satellite-notify-multi-select": SatelliteNotifyMultiSelect,
  },
  data: {
    menu: {
      cat: false,
      sat: false,
      gs: false,
      map: false,
      ios: false,
      dbg: false,
    },
    imageryProvider: "offline",
    sceneMode: "3D",
    isIOS: cc.isIOS,
    groundStationPicker: cc.groundStationPicker,
    enabledComponents: cc.sats.enabledComponents,
  },
  watch: {
    imageryProvider: function(newProvider) {
      cc.setImageryProvider = newProvider;
    },
    sceneMode: function(newMode) {
      cc.setSceneMode = newMode;
    },
    enabledComponents: function(newComponents, oldComponents) {
      let add = newComponents.filter(x => !oldComponents.includes(x));
      for (let component of add) {
        cc.sats.enableComponent(component);
      }
      let del = oldComponents.filter(x => !newComponents.includes(x));
      for (let component of del) {
        cc.sats.disableComponent(component);
      }
    },
  },
  methods: {
    toggleMenu: function(name) {
      const oldState = this.menu[name];
      Object.keys(this.menu).forEach(k => this.menu[k] = false);
      this.menu[name] = !oldState;
    },
  },
});

// Export Vue for debugger
window.app = app;

cc.sats.addFromTle("FIRST-MOVE\n1 39439U 13066Z   18296.51686911 +.00000452 +00000-0 +61736-4 0  9995\n2 39439 097.5861 317.6165 0067126 096.1150 264.7717 14.81612291264583", ["Custom"]);
cc.sats.addFromTle("MOVE-II\n1 25544U 98067A   18257.91439815  .00001783  00000-0  34518-4 0  9997\n2 25544  51.6414 291.5521 0005015 157.3801 208.5555 15.53849779132479", ["Custom"]);
cc.sats.addFromTle("EVE-1\n1 39439U 13066Z   18203.92296999 +.00000436 +00000-0 +59983-4 0  9994\n2 39439 097.5919 229.8528 0066721 040.9363 319.6832 14.81533022250876", ["Custom"]);
cc.sats.addFromTle("ISS\n1 25544U 98067A   18298.51635846  .00001514  00000-0  30392-4 0  9998\n2 25544  51.6406  89.2479 0003892 336.3122 134.3245 15.53861856138782", ["Station"]);
cc.sats.addFromTleUrl("data/tle/weather.txt", ["Weather"]);
cc.sats.addFromTleUrl("data/tle/resource.txt", ["Resource"]);
cc.sats.addFromTleUrl("data/tle/science.txt", ["Science"]);

cc.sats.enableTag("Custom");
cc.sats.enableTag("Station");
cc.sats.enableTag("Weather");
cc.sats.getSatellite("MOVE-II").track();
