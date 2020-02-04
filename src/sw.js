import { skipWaiting, clientsClaim } from "workbox-core";
import { registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

// Cache Cesium runtime dependencies
registerRoute(
  /dist\/(Assets|Widgets|Workers)\/.*\.(css|js|json)$/,
  new CacheFirst({
    cacheName: "cesium-cache",
  })
);

// Cache high res map tiles
registerRoute(
  /data\/cesium-assets\/imagery\/.*\.(jpg|xml)$/,
  new CacheFirst({
    cacheName: "cesium-tile-cache",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 20000,
        maxAgeSeconds: 7 * 24 * 60 * 60,
        purgeOnQuotaError: true,
      })
    ]
  })
);

cleanupOutdatedCaches();
precacheAndRoute(self.__precacheManifest || self.__WB_MANIFEST);
skipWaiting();
clientsClaim();
