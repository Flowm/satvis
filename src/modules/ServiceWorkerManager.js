export class ServiceWorkerManager {
  static registerAndUpdate() {
    // Register service worker
    if (!("serviceWorker" in navigator)) {
      console.log("SW unavailable");
      return;
    }

    // XXX: Temporary workaround for cesium cache issue on upgrade
    // https://github.com/AnalyticalGraphicsInc/cesium/issues/7617
    caches.keys().then(cacheNames => {
      console.log(cacheNames)
      cacheNames.forEach(cacheName => {
        caches.delete(cacheName);
      });
    });

    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").then(reg => {
        console.log("SW registered:", reg);

        // Update service worker on page refresh
        // https://redfin.engineering/how-to-fix-the-refresh-button-when-using-service-workers-a8e27af6df68
        function listenForWaitingServiceWorker(reg, callback) {
          function awaitStateChange () {
            reg.installing.addEventListener("statechange", function () {
              if (this.state === "installed") callback(reg);
            });
          }
          if (!reg) return;
          if (reg.waiting) return callback(reg);
          if (reg.installing) awaitStateChange();
          reg.addEventListener("updatefound", awaitStateChange);
        }

        // Reload once when the new Service Worker starts activating
        var refreshing = false;
        navigator.serviceWorker.addEventListener("controllerchange", function () {
          console.log("Reloading page for latest content");
          if (refreshing) return;
          refreshing = true;
          window.location.reload();
        });
        function promptUserToRefresh (reg) {
          console.log("New version available!");
          // Immediately load service worker
          reg.waiting.postMessage("skipWaiting");
          // if (window.confirm("New version available! OK to refresh?")) {
          //  reg.waiting.postMessage("skipWaiting");
          // }
        }
        listenForWaitingServiceWorker(reg, promptUserToRefresh);
      }).catch(registrationError => {
        console.log("SW registration failed: ", registrationError);
      });
    });
  }
}
