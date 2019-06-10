import Vue from "vue";
import App from "./App.vue";
import router from "./components/Router";
import { Workbox } from "workbox-window";

const app = new Vue({
  el: "#app",
  router,
  components: { App },
  template: "<App/>"
});

// Export Vue for debugger
window.app = app;

/* global cc */
//cc.sats.addFromTleUrl("data/tle/norad/active.txt", ["ACTIVE"]);
cc.sats.addFromTleUrl("data/tle/norad/planet.txt", ["PLANET"]);
cc.sats.addFromTleUrl("data/tle/norad/starlink.txt", ["STARLINK"]);
cc.sats.addFromTleUrl("data/tle/norad/resource.txt", ["Resource"]);
cc.sats.addFromTleUrl("data/tle/norad/science.txt", ["Science"]);
cc.sats.addFromTleUrl("data/tle/norad/stations.txt", ["Stations"]);
cc.sats.addFromTleUrl("data/tle/norad/weather.txt", ["Weather"]);

cc.sats.addFromTleUrl("data/tle/custom/move.txt", ["MOVE"]);
cc.sats.addFromTleUrl("data/tle/custom/ot.txt", ["OT"]);

cc.sats.enableTag("MOVE");

// Register service worker
if ("serviceWorker" in navigator) {
  const wb = new Workbox("sw.js");

  wb.addEventListener("waiting", (event) => {
    if (confirm("A new version is available! Click OK to refresh")) {
      wb.addEventListener("controlling", (event) => {
        window.location.reload();
      });
      wb.messageSW({type: "SKIP_WAITING"});
    }
  });
  wb.register();
}
