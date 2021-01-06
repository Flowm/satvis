import Vue from "vue";
import App from "./App.vue";
import router from "./components/Router";
import { Workbox } from "workbox-window";
import * as Cesium from "Cesium/Cesium";

const app = new Vue({
  el: "#app",
  router,
  components: { App },
  template: "<App/>"
});

// Export Vue for debugger
window.app = app;

/* global cc */
//cc.sats.addFromTleUrl("data/tle/norad/active.txt", ["Active"]);
cc.sats.addFromTleUrl("data/tle/ext/wfs.txt", ["WFS"]);
cc.sats.addFromTleUrl("data/tle/ext/wfsf.txt", ["WFSF"]);
cc.sats.addFromTleUrl("data/tle/norad/planet.txt", ["Planet"]);
cc.sats.addFromTleUrl("data/tle/norad/starlink.txt", ["Starlink"]);
cc.sats.addFromTleUrl("data/tle/norad/globalstar.txt", ["Globalstar"]);

//cc.sats.addFromTleUrl("data/tle/ext/ot576-24.txt", ["OT576-24"]);
//cc.sats.addFromTleUrl("data/tle/ext/ot288-24.txt", ["OT288-24"]);
//cc.sats.addFromTleUrl("data/tle/ext/ot288-12.txt", ["OT288-12"]);
//cc.sats.addFromTleUrl("data/tle/ext/ot144-12.txt", ["OT144-12"]);
cc.sats.addFromTleUrl("data/tle/ext/otmvc.txt", ["OTMVC-1-16"]);
cc.sats.addFromTleUrl("data/tle/ext/otmvc-8-16.txt", ["OTMVC-8-16"]);
cc.sats.addFromTleUrl("data/tle/ext/otmvc-8-24.txt", ["OTMVC-8-24"]);

// Register service worker
if ("serviceWorker" in navigator) {
  const wb = new Workbox("sw.js");
  wb.addEventListener("waiting", () => {
    wb.addEventListener("controlling", () => {
      console.log("Reloading page for latest content");
      window.location.reload();
    });
    wb.messageSW({type: "SKIP_WAITING"});
    // Old serviceworker message for migration, can be removed in the future
    wb.messageSW("SKIP_WAITING");
  });
  wb.register();
}

if (cc.sats.enabledTags.length === 0) {
  cc.setTime("2019-07-01");
  cc.sats.enableTag("OT144-12");
  cc.sats.enableTag("Globalstar");
  cc.sats.disableComponent("Label");
  cc.imageryProvider = "ArcGis";
  setTimeout(() => {
    cc.sats.getSatellitesWithTag("OT144-12").forEach(sat => { sat.enableComponent("Orbit"); sat.enableComponent("Sensor cone"); });
    cc.sats.getSatellitesWithTag("OT144-12").forEach(sat => { sat.entities["Orbit"].path.material = Cesium.Color.WHITE.withAlpha(0.01); });
    cc.sats.getSatellitesWithTag("Globalstar").forEach(sat => { sat.entities["Point"].point.color = Cesium.Color.RED; sat.entities["Point"].point.pixelSize = 5; });
  }, 2000);
}
