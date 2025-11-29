import { createApp, markRaw } from "vue";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import Aura from "@primevue/themes/aura";
import Tooltip from "primevue/tooltip";
import ToastService from "primevue/toastservice";
import * as Sentry from "@sentry/browser";
import { library } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faEye, faTrash, faLink, faLinkSlash, faSave, faExclamationTriangle } from "@fortawesome/free-solid-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";

import App from "./App.vue";
import { router, setupRouterGuards } from "./router";
import piniaUrlSync from "./modules/util/pinia-plugin-url-sync.ts";
import { CesiumController } from "./modules/CesiumController";
import { getConfigPreset } from "./config/presets";
import { usePWAUpdate } from "./composables/usePWAUpdate.ts";

// Enable sentry for production version
if (window.location.href.includes("satvis.space")) {
  Sentry.init({ dsn: "https://6c17c8b3e731026b3e9e0df0ecfc1b83@o294643.ingest.us.sentry.io/1541793" });
}

// Register Service Worker with automatic reload on update
const { registerPWA } = usePWAUpdate({ autoUpdate: true });
registerPWA();

// Setup Vue app
const app = createApp(App);
const cc = new CesiumController();
app.config.globalProperties.cc = cc;

// Setup Pinia with customConfig from preset
const pinia = createPinia();
pinia.use(({ store }) => {
  store.router = markRaw(router);
  store.customConfig = markRaw(getConfigPreset().config);
});
pinia.use(piniaUrlSync);
app.use(pinia);

// Setup router guards to handle configuration changes on route changes
setupRouterGuards(router, cc);
app.use(router);

app.use(PrimeVue, {
  theme: {
    preset: Aura,
  },
});

// Setup directives and components
app.directive("tooltip", Tooltip);
app.use(ToastService);
library.add(faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faEye, faTrash, faLink, faLinkSlash, faSave, faExclamationTriangle, faGithub);
app.component("FontAwesomeIcon", FontAwesomeIcon);

// Mount the app
app.mount("#app");
