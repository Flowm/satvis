import { registerSW } from "virtual:pwa-register";
import { ref } from "vue";

interface UsePWAUpdateOptions {
  /** Reload as soon as a new version is detected. Defaults to false. */
  autoUpdate?: boolean;
  /** Seconds between update checks; 0 disables them. Defaults to 86400. */
  updateInterval?: number;
}

/** Runtime caches renamed in vite.config.ts; Workbox deletes only outdated precaches. */
const RETIRED_CACHES = ["satellite-model-cache"];

const needRefresh = ref(false);
const offlineReady = ref(false);
let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;
let registered = false;
let intervalId: ReturnType<typeof setInterval> | undefined;

/** Registers the service worker on the first call; later calls share its state and ignore their options. */
export function usePWAUpdate(options: UsePWAUpdateOptions = {}) {
  const { autoUpdate = false, updateInterval = 60 * 60 * 24 } = options;

  const updateApp = async () => {
    if (updateSW) {
      try {
        await updateSW(true);
        needRefresh.value = false;
      } catch (error) {
        console.error("PWA: Failed to update app:", error);
      }
    }
  };

  if (!registered) {
    registered = true;

    updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        console.log("PWA: Update available - need refresh");
        needRefresh.value = true;

        if (autoUpdate) {
          console.log("PWA: Auto-update enabled, updating app...");
          updateApp();
        }
      },
      onOfflineReady() {
        console.log("PWA: App is ready to work offline");
        offlineReady.value = true;
      },
      onRegistered(registration: ServiceWorkerRegistration | undefined) {
        console.log("PWA: Service worker registered successfully");
        RETIRED_CACHES.forEach((name) => void caches.delete(name).catch(() => {}));

        if (registration && updateInterval > 0 && !intervalId) {
          intervalId = setInterval(() => {
            console.log("PWA: Checking for updates...");
            registration.update();
          }, updateInterval * 1000);
        }
      },
      onRegisterError(error: Error) {
        console.error("PWA: Service worker registration error:", error);
      },
    });
  }

  return {
    needRefresh,
    offlineReady,
    updateApp,
  };
}
