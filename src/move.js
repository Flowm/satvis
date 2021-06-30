import Vue from "vue";
import { Workbox } from "workbox-window";
import App from "./App.vue";
import router from "./components/Router";

const app = new Vue({
  el: "#app",
  components: {
    app: App,
  },
  render: (h) => h("app"),
  router,
});

// Export Vue for debugger
window.app = app;

/* global cc */
cc.sats.addFromTleUrl("data/tle/ext/move.txt", ["MOVE"]);
if (cc.sats.enabledTags.length === 0) {
  cc.sats.enableTag("MOVE");
}

// Register service worker
if ("serviceWorker" in navigator) {
  const wb = new Workbox("sw.js");
  wb.addEventListener("waiting", () => {
    wb.addEventListener("controlling", () => {
      console.log("Reloading page for latest content");
      window.location.reload();
    });
    wb.messageSW({ type: "SKIP_WAITING" });
    // Old serviceworker message for migration, can be removed in the future
    wb.messageSW("SKIP_WAITING");
  });
  wb.register();
}
