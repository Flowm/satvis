import { createApp, markRaw } from "vue";
import { createPinia } from "pinia";
import { Workbox } from "workbox-window";
import { Tooltip } from "@oruga-ui/oruga-next";
import Toast from "vue-toastification";
import * as Sentry from "@sentry/browser";
import { library } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faEye } from "@fortawesome/free-solid-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";

import App from "./App.vue";
import router from "./components/Router";
import piniaUrlSync from "./modules/util/pinia-plugin-url-sync";
import { CesiumController } from "./modules/CesiumController";

function satvisSetup(customConfig = {}) {
  // Enable sentry for production version
  if (window.location.href.includes("satvis.space")) {
    Sentry.init({ dsn: "https://d17adce0cef2411aa49e3fc6d6ec0aa7@o294643.ingest.sentry.io/1541793" });
  }

  // Setup and init app
  const app = createApp(App);
  const cc = new CesiumController();
  app.config.globalProperties.cc = cc;
  const pinia = createPinia();
  pinia.use(({ store }) => { store.router = markRaw(router); });
  pinia.use(({ store }) => { store.customConfig = markRaw(customConfig); });
  pinia.use(piniaUrlSync);
  app.use(pinia);
  app.use(router);
  app.use(Tooltip);
  app.use(Toast, {
    position: "bottom-right",
  });
  library.add(faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faEye, faGithub);
  app.component("FontAwesomeIcon", FontAwesomeIcon);
  app.mount("#app");

  // Register service worker
  if ("serviceWorker" in navigator && !window.location.href.includes("localhost")) {
    const wb = new Workbox("sw.js");
    wb.addEventListener("controlling", (evt) => {
      if (evt.isUpdate) {
        console.log("Reloading page for latest content");
        window.location.reload();
      }
    });
    wb.register();
  }

  return { app, cc };
}

export default satvisSetup;
