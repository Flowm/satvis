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
    /**
     * A console handle for debugging, and nothing else: the app itself reaches
     * the controller through `provide`/`inject` (see composables/useController)
     * or an argument. Assigned here rather than by the controller's own
     * constructor, so constructing one has no global side effect.
     */
    cc?: CesiumController;
  }
}

usePWAUpdate({ autoUpdate: true });

// Before the viewer: everything ion-backed resolves through this one token, and
// nothing here can pass it per asset. See src/config/ion.ts.
Ion.defaultAccessToken = ionAccessToken;

// The composition root. The viewer is built here and handed to the controller,
// which is handed to the Vue tree — so every edge into the globe is an argument
// somebody passed rather than a global somebody found.
const app = createApp(App);
const viewer = createViewer("cesiumContainer", { minimalUI: DeviceDetect.minimalUI() });
const cc = new CesiumController(viewer);
app.provide(controllerKey, cc);
window.cc = cc;

// The url sync waits for this before it reads the url: the url only states what
// differs from the preset.
const presetDefaults = markRaw(resolvePreset().then((preset) => preset.defaults));

const pinia = createPinia();
pinia.use(({ store }) => {
  store.router = markRaw(router);
  store.presetDefaults = presetDefaults;
});
pinia.use(piniaUrlSync);
app.use(pinia);

// Carry store state into the globe. Not a component: it has to outlive every
// panel, and it must not depend on component mount order.
startSceneSync(cc);

setupRouterGuards(router, cc);
app.use(router);

app.use(ui);

app.mount("#app");

// The loading screen in index.html has served its purpose once the globe is up.
// Faded rather than cut, so the handover reads as the screen resolving; removed
// rather than left hidden, because it is a full-screen overlay and leaving it in
// the tree would leave a second <h1> in the rendered document. Anything that
// never runs this file keeps it.
//
// index.html holds no comments of its own, being served to every visitor exactly
// as written, so the two things about its markup that are not self-evident live
// here. #shell sits outside #app because `[v-cloak]` hides that until Vue mounts,
// and a loading state nobody sees is not one. Its link to /about is the only one
// in the raw html: Googlebot runs this bundle and finds the toolbar link instead,
// but a crawler that does not has nothing else pointing at that page.
const shell = document.getElementById("shell");
if (shell) {
  shell.classList.add("is-done");
  // On the transition rather than a bare timer, so the node goes exactly when the
  // fade ends — with a timer behind it because transitionend never fires when the
  // transition is off (prefers-reduced-motion) or the tab is in the background.
  shell.addEventListener("transitionend", () => shell.remove(), { once: true });
  setTimeout(() => shell.remove(), 1000);
}
