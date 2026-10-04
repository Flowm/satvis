import { createRouter, createWebHistory, type Router, START_LOCATION } from "vue-router";

import Satvis from "../components/Satvis.vue";
import { usePostHog } from "../composables/usePostHog";
import { resolvePreset, updateMetadata } from "../config/presets";
import type { CesiumController } from "../modules/CesiumController";

const base = document.location.pathname.match(".*/")?.[0] ?? "/";

export const router: Router = createRouter({
  history: createWebHistory(base),
  routes: [
    { path: "/", component: Satvis, name: "default" },
    { path: "/ot", component: Satvis, name: "ot" },
    // Legacy paths.
    { path: "/index.html", redirect: "/" },
    { path: "/ot.html", redirect: "/ot" },
    // Unknown paths (e.g. the retired /move route) render the default preset
    // rather than an empty router-view; resolvePreset falls back to `default`.
    { path: "/:pathMatch(.*)*", component: Satvis, name: "fallback" },
  ],
});

/** The initial load is not routed through here — see src/app.ts, before mounting. */
export function setupRouterGuards(routerInstance: Router, cc: CesiumController): void {
  routerInstance.beforeEach((to, from) => {
    // Every url-sync write is a same-path navigation, so without this the
    // preset would be re-registered on every checkbox toggle. START_LOCATION
    // also reports path "/", so the initial load has to be let through
    // explicitly or the default route never registers its element sets.
    if (from !== START_LOCATION && to.path === from.path) {
      return true;
    }
    console.log(`Navigating to ${to.path} from ${from.path}`);

    // Register the preset's element sets with the satellite catalog; only the
    // groups required by the current activation state are actually fetched.
    // Not awaited: the preset arrives with the group index, and nothing about
    // the navigation itself waits on it.
    void resolvePreset(to.path).then((preset) => {
      updateMetadata(preset);
      void cc.sats.loadElementSets(preset.elements);
    });

    return true;
  });
}

usePostHog();
