/* global workbox */
//workbox.setConfig({ debug: true });

// Update service worker on page refresh
addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    skipWaiting();
  }
});

// Cache Cesium runtime dependencies
workbox.routing.registerRoute(
  /dist\/(Assets|Widgets|Workers)\/.*\.(css|js|json)$/,
  new workbox.strategies.CacheFirst({
    cacheName: "cesium-cache",
  })
);

// Cache high res map tiles
workbox.routing.registerRoute(
  /data\/cesium-assets\/imagery\/.*\.(jpg|xml)$/,
  new workbox.strategies.CacheFirst({
    cacheName: "cesium-tile-cache",
    plugins: [
      new workbox.expiration.Plugin({
        maxEntries: 20000,
        maxAgeSeconds: 7 * 24 * 60 * 60,
        purgeOnQuotaError: true
      })
    ]
  })
);

workbox.precaching.precacheAndRoute(self.__precacheManifest || []);
