import { CesiumController } from "./modules/CesiumController";
import Vue from "vue";
import SatelliteSelect from "./components/SatelliteSelect.vue";
import SatelliteMultiSelect from "./components/SatelliteMultiSelect.vue";

import "cesium/Widgets/widgets.css";
import "./css/main.css";

// Register service worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").then(reg => {
      console.log("SW registered:", reg);

      // Update service worker on page refresh
      // https://redfin.engineering/how-to-fix-the-refresh-button-when-using-service-workers-a8e27af6df68
      function listenForWaitingServiceWorker(reg, callback) {
        function awaitStateChange () {
          reg.installing.addEventListener("statechange", function () {
            if (this.state === "installed") callback(reg);
          });
        }
        if (!reg) return;
        if (reg.waiting) return callback(reg);
        if (reg.installing) awaitStateChange();
        reg.addEventListener("updatefound", awaitStateChange);
      }

      // Reload once when the new Service Worker starts activating
      var refreshing;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        console.log("Reloading page for latest content");
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
      function promptUserToRefresh (reg) {
        console.log("New version available!");
        // Immediately load service worker
        reg.waiting.postMessage("skipWaiting");
        // if (window.confirm("New version available! OK to refresh?")) {
        //  reg.waiting.postMessage('skipWaiting');
        // }
      }
      listenForWaitingServiceWorker(reg, promptUserToRefresh);
    }).catch(registrationError => {
      console.log("SW registration failed: ", registrationError);
    });
  });
}

/*global cc*/
const VueCesiumController = {
  install(Vue) {
    Vue.prototype.cc = new CesiumController();
  }
};
//export default VueCesiumController;
Vue.use(VueCesiumController);

const app = new Vue({
  components: {
    "satellite-select": SatelliteSelect,
    "satellite-multi-select": SatelliteMultiSelect,
  },
  el: "#toolbar",
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
  methods: {
    toggleMenu: function(name) {
      const oldState = this.menu[name];
      Object.keys(this.menu).forEach(k => this.menu[k] = false);
      this.menu[name] = !oldState;
    },
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
