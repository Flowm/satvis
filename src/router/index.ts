import { createRouter, createWebHistory, type Router } from "vue-router";

import Satvis from "../components/Satvis.vue";
import { usePostHog } from "../composables/usePostHog";

const base = document.location.pathname.match(".*/")?.[0] ?? "/";

/** Every path renders the app, which opens the preset the path names (src/config/presets.ts). */
export const router: Router = createRouter({
  history: createWebHistory(base),
  routes: [
    // Legacy paths.
    { path: "/index.html", redirect: "/" },
    { path: "/ot.html", redirect: "/ot" },
    { path: "/:pathMatch(.*)*", component: Satvis },
  ],
});

usePostHog();
