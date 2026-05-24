import { createApp, markRaw } from "vue";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import Aura from "@primeuix/themes/aura";
import Tooltip from "primevue/tooltip";
import ToastService from "primevue/toastservice";

import { library } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { faLayerGroup, faGlobeAfrica, faMobileAlt, faHammer, faEye, faTrash, faLink, faLinkSlash, faSave, faExclamationTriangle } from "@fortawesome/free-solid-svg-icons";
import { faGithub } from "@fortawesome/free-brands-svg-icons";

import App from "./App.vue";
import { router, setupRouterGuards } from "./router";
import piniaUrlSync from "./modules/util/pinia-plugin-url-sync";
import { CesiumController } from "./modules/CesiumController";
import { getConfigPreset } from "./config/presets";
import { usePWAUpdate } from "./composables/usePWAUpdate";

// Register Service Worker with automatic reload on update
usePWAUpdate({ autoUpdate: true });

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
