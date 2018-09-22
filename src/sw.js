//workbox.setConfig({ debug: true });

// Update service worker on page refresh
addEventListener("message", event => {
  if (event.data === "skipWaiting") {
    skipWaiting();
  }
});

// Cache Cesium runtime dependencies
workbox.routing.registerRoute(
  /dist\/(Assets|Widgets|Workers)\/.*\.(css|js|json)$/,
  workbox.strategies.cacheFirst({
    cacheName: "cesium-cache",
  })
);

// Cache high res map tiles
workbox.routing.registerRoute(
  /data\/cesium-assets\/imagery\/.*\.(jpg|xml)$/,
  workbox.strategies.cacheFirst({
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
