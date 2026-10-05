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
    // Unknown paths render the default preset rather than an empty router-view.
    { path: "/:pathMatch(.*)*", component: Satvis, name: "fallback" },
  ],
});

export function setupRouterGuards(routerInstance: Router, cc: CesiumController): void {
  routerInstance.beforeEach((to, from) => {
    // Every url-sync write is a same-path navigation. START_LOCATION also reports "/", so the
    // initial load is let through explicitly or the default route registers no element sets.
    if (from !== START_LOCATION && to.path === from.path) {
      return true;
    }
    console.log(`Navigating to ${to.path} from ${from.path}`);

    // Only groups the activation needs are fetched. Not awaited: the navigation does not depend on it.
    void resolvePreset(to.path).then((preset) => {
      updateMetadata(preset);
      void cc.sats.loadElementSets(preset.elements);
    });

    return true;
  });
}

usePostHog();
