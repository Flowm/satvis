import posthogClient from "posthog-js/dist/module.full.no-external";

import { sanitizePostHogEvent } from "../modules/util/posthogPrivacy";

let initialized = false;

/**
 * From `pagehide` until the page shows again. Registered as this module loads, before the
 * router module creates vue-router, so it runs ahead of vue-router's own `pagehide` listener.
 */
let pageHiding = false;
// Not in vitest's node environment, which imports this module through CesiumController.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    pageHiding = true;
  });
  window.addEventListener("pageshow", () => {
    pageHiding = false;
  });
}

export function usePostHog() {
  if (!initialized) {
    const projectKey = import.meta.env.VITE_POSTHOG_KEY;
    const apiHost = import.meta.env.VITE_POSTHOG_API_HOST || "https://eu.i.posthog.com";
    const uiHost = import.meta.env.VITE_POSTHOG_UI_HOST || "https://eu.posthog.com";

    if (projectKey && window.location.href.includes("satvis.space")) {
      posthogClient.init(projectKey, {
        api_host: apiHost,
        ui_host: uiHost,
        before_send: (event) => {
          // Firefox refuses vue-router's scroll-saving `replaceState` on `pagehide` in a frame its
          // parent reloads. Nothing breaks, but dashboards reloading satvis every 5 minutes made it
          // 98% of all exceptions. Only while hiding: otherwise the same error means blocked storage.
          const exceptions = event?.properties.$exception_list as { type?: string; value?: string }[] | undefined;
          const unloadNoise =
            pageHiding && event?.event === "$exception" && !!exceptions?.length && exceptions.every((e) => e.type === "DOMException" && e.value?.startsWith("SecurityError"));
          if (!event || unloadNoise) {
            return null;
          }
          sanitizePostHogEvent(event);
          return event;
        },
        cookieless_mode: "always",
        defaults: "2026-01-30",
      });
      posthogClient.register({
        build_date: __BUILD_DATE__,
        build_sha: __BUILD_SHA__,
      });
    }
    initialized = true;
  }

  return { posthog: posthogClient };
}
