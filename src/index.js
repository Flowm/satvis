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
  el: "#toolbarLeft",
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

cc.sats.addFromTleUrl("data/tle/custom.txt", ["Custom"]);
cc.sats.addFromTleUrl("data/tle/resource.txt", ["Resource"]);
cc.sats.addFromTleUrl("data/tle/science.txt", ["Science"]);
cc.sats.addFromTleUrl("data/tle/stations.txt", ["Stations"]);
cc.sats.addFromTleUrl("data/tle/weather.txt", ["Weather"]);

cc.sats.enableTag("Custom");
cc.sats.enableTag("Stations");
//cc.sats.enableTag("Weather");
