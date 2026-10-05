import { Ion } from "@cesium/engine";
import ui from "@nuxt/ui/vue-plugin";
import { createPinia } from "pinia";
import { createApp, markRaw } from "vue";

import App from "./App.vue";
import { controllerKey } from "./composables/useController";
import { usePWAUpdate } from "./composables/usePWAUpdate";
import { ionAccessToken } from "./config/ion";
import { resolvePreset } from "./config/presets";
import { CesiumController } from "./modules/CesiumController";
import { createViewer } from "./modules/createViewer";
import { startSceneSync } from "./modules/sceneSync";
import { DeviceDetect } from "./modules/util/DeviceDetect";
import piniaUrlSync from "./modules/util/urlSync";
import { router, setupRouterGuards } from "./router";

declare global {
  interface Window {
    /** A console handle for debugging only; the app uses `provide`/`inject` (composables/useController). */
    cc?: CesiumController;
  }
}

usePWAUpdate({ autoUpdate: true });

// Before the viewer: every ion asset resolves through this token (src/config/ion.ts).
Ion.defaultAccessToken = ionAccessToken;

const app = createApp(App);
const viewer = createViewer("cesiumContainer", { minimalUI: DeviceDetect.minimalUI() });
const cc = new CesiumController(viewer);
app.provide(controllerKey, cc);
window.cc = cc;

// Frames for a page the browser presents none in, such as an automated pane.
if (new URLSearchParams(window.location.search).has("framems")) {
  void import("./modules/benchmark/framePump").then(({ installFramePumpIfRequested }) => installFramePumpIfRequested(viewer, window.location.search));
}

// The url sync waits for this: the url only states what differs from the preset.
const presetDefaults = markRaw(resolvePreset().then((preset) => preset.defaults));

const pinia = createPinia();
pinia.use(({ store }) => {
  store.router = markRaw(router);
  store.presetDefaults = presetDefaults;
});
pinia.use(piniaUrlSync);
app.use(pinia);

// Not a component: it must outlive every panel and not depend on mount order.
startSceneSync(cc);

setupRouterGuards(router, cc);
app.use(router);

app.use(ui);

app.mount("#app");

// The index.html loading screen is removed, not hidden, or the document keeps a second <h1>.
// index.html carries no comments, so: #shell sits outside #app because `[v-cloak]` hides #app,
// and its /about link is the only one a crawler that skips this bundle can find.
const shell = document.getElementById("shell");
if (shell) {
  shell.classList.add("is-done");
  // The timer covers reduced motion and background tabs, where transitionend never fires.
  shell.addEventListener("transitionend", () => shell.remove(), { once: true });
  setTimeout(() => shell.remove(), 1000);
}
