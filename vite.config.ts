/// <reference types="node" />
/// <reference types="vitest/config" />

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ui from "@nuxt/ui/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { viteStaticCopy } from "vite-plugin-static-copy";

const cesiumEngineSource = "node_modules/@cesium/engine";
const cesiumWidgetsSource = "node_modules/@cesium/widgets";
const cesiumBaseUrl = "cesium";

const buildDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
let buildSha = "dev";
try {
  buildSha = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  // not a git checkout (e.g. tarball build)
}

const port = process.env.PORT ? Number(process.env.PORT) : undefined;

// Headers for `performance.measureUserAgentSpecificMemory()` to provide accurate memory data in the benchmark panel.
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

// The repo ships with levels 0-2, run `pnpm update-imagery` to generate levels 0-5.
// Levels 0-3 are precached by the service worker (if available), levels 4-5 are runtime cached.
const generatedImagery = existsSync(fileURLToPath(new URL("data/imagery/NaturalEarthII/3/0/0.webp", import.meta.url)));
const COMMITTED_MAX_LEVEL = 2;
const GENERATED_MAX_LEVEL = 5;

export default defineConfig({
  base: "",
  build: {
    sourcemap: true,
    // Cesium is 4.2 MB minified (Scene 49%, Core 19%, DataSources 9%)
    chunkSizeWarningLimit: 4500,
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        about: fileURLToPath(new URL("about.html", import.meta.url)),
        embedded: fileURLToPath(new URL("embedded.html", import.meta.url)),
        test: fileURLToPath(new URL("test.html", import.meta.url)),
      },
      output: {
        codeSplitting: {
          groups: [
            { name: "vue", test: /@vue|vue-router|pinia|@vueuse/, priority: 60 },
            { name: "ui", test: /@nuxt\/ui|reka-ui|tailwindcss|@tanstack/, priority: 50 },
            { name: "icons", test: /@iconify/, priority: 40 },
            { name: "cesium", test: /@?cesium/, priority: 30 },
            { name: "analytics", test: /posthog/, priority: 20 },
            { name: "vendor", test: /node_modules/, priority: 10 },
          ],
        },
      },
    },
  },
  define: {
    CESIUM_BASE_URL: JSON.stringify("./cesium"),
    __BUILD_DATE__: JSON.stringify(buildDate),
    __BUILD_SHA__: JSON.stringify(buildSha),
    __IMAGERY_MAX_LEVEL__: JSON.stringify(generatedImagery ? GENERATED_MAX_LEVEL : COMMITTED_MAX_LEVEL),
  },
  plugins: [
    vue(),
    ui({
      ui: { colors: { neutral: "neutral" } },
      icon: { clientBundle: { scan: true } },
    }),
    viteStaticCopy({
      targets: [
        { src: `${cesiumEngineSource}/Build/ThirdParty`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        // Cesium's on-demand decoders (Draco, KTX2) are only in Source/ThirdParty.
        { src: `${cesiumEngineSource}/Source/ThirdParty/*.wasm`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumEngineSource}/Build/Workers`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        {
          src: [`${cesiumEngineSource}/Source/Assets/**`, `!${cesiumEngineSource}/Source/Assets/Textures/NaturalEarthII/**`],
          dest: cesiumBaseUrl,
          rename: { stripBase: 4 },
        },
        { src: `${cesiumWidgetsSource}/Source`, dest: `${cesiumBaseUrl}/Widgets`, rename: { stripBase: 4 } },
        { src: ["data/**", "!data/custom/**", "!data/models/**"], dest: "data", rename: { stripBase: 1 } },
        // The models repo ships only public/, as a plugin's sync does (ADR 0007).
        { src: "data/models/public/**", dest: "data/models", rename: { stripBase: 3 } },
        { src: ["data/custom/dist/**"], dest: "data", rename: { stripBase: 3 } },
      ],
    }),
    VitePWA({
      registerType: "prompt",
      manifest: {
        name: "Satellite Orbit Visualization",
        short_name: "SatVis",
        description:
          "Track 12,000+ satellites live on a 3D globe, or point your phone at the sky to spot them. Starlink, GPS, the ISS and more. Pass prediction, alerts, offline PWA.",
        start_url: "/",
        scope: "/",
        id: "satvis.space",
        orientation: "natural",
        display: "standalone",
        background_color: "#000000",
        theme_color: "#000000",
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5000000,
        globPatterns: [
          "**/*.{js,css,html,svg,png,ico}",
          "cesium/Assets/**/*.{jpg,png,xml,json}",
          "data/imagery/NaturalEarthII/{0,1,2,3}/**/*.webp",
          "data/imagery/NaturalEarthII/tilemapresource.xml",
        ],
        globIgnores: ["cesium/ThirdParty/**/*", "cesium/Widgets/**/*", "cesium/Workers/**/*", "cesium/Assets/Textures/maki/*", "**/*.map", "data/privacy.html"],
        sourcemap: true,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/\.(css|js|png|svg|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|txt|glb)$/, /^\/api\//, /^\/data\//, /^\/cesium\//, /^\/\.well-known\//],
        runtimeCaching: [
          {
            urlPattern: /cesium\/(Assets|Widgets|Workers)\/.*\.(css|js|json|jpg)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "cesium-cache",
              expiration: {
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
            },
          },
          {
            urlPattern: /data\/imagery\/.*\.(webp|jpg|png|xml)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "cesium-tile-cache",
              expiration: {
                maxEntries: 20000,
                maxAgeSeconds: 30 * 24 * 60 * 60,
                purgeOnQuotaError: true,
              },
            },
          },
          {
            urlPattern: /data\/starmap\/.*\.webp$/,
            handler: "CacheFirst",
            options: {
              cacheName: "cesium-starmap-cache",
              expiration: {
                maxEntries: 12,
                maxAgeSeconds: 30 * 24 * 60 * 60,
                purgeOnQuotaError: true,
              },
            },
          },
          {
            urlPattern: /(\/api\/(gp\/[^/]+|groups|metadata)|data\/gp\/[^/]+)\.json$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "satellite-data-cache",
              expiration: {
                maxAgeSeconds: 48 * 60 * 60,
                maxEntries: 50,
              },
            },
          },
          {
            urlPattern: /data\/models\/.*\.glb$/,
            handler: "CacheFirst",
            options: {
              // Versioned: cache-first would keep serving the models replaced under the same names.
              cacheName: "satellite-model-cache-v2",
              expiration: {
                maxAgeSeconds: 30 * 24 * 60 * 60,
                maxEntries: 50,
                purgeOnQuotaError: true,
              },
            },
          },
        ],
      },
      pwaAssets: {
        htmlPreset: "2023",
        preset: {
          transparent: {
            sizes: [64, 192, 512],
            favicons: [[48, "favicon.ico"]],
          },
          maskable: {
            sizes: [512],
            padding: 0,
          },
          apple: {
            sizes: [180],
            padding: 0,
          },
        },
        image: "public/logo.svg",
      },
      devOptions: {
        type: "module",
      },
    }),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: [
      // Cuts satellite.js's Emscripten bundles before Vite reads them: unused here,
      // and the source of fifteen "externalized for browser compatibility" warnings.
      { find: "#wasm-single-thread", replacement: fileURLToPath(new URL("src/modules/util/satelliteWasmRuntime.ts", import.meta.url)) },
      { find: "#wasm-multi-thread", replacement: fileURLToPath(new URL("src/modules/util/satelliteWasmRuntime.ts", import.meta.url)) },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  server: {
    port,
    strictPort: port !== undefined,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
    proxy: {
      // Proxy /api to production by default so `pnpm dev` works out of the box.
      // Point at a local worker with SATVIS_API_PROXY=http://localhost:8080.
      "/api": {
        target: process.env.SATVIS_API_PROXY ?? "https://satvis.space",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    strictPort: port !== undefined,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
    proxy: {
      "/api": {
        target: process.env.SATVIS_API_PROXY ?? "https://satvis.space",
        changeOrigin: true,
      },
    },
  },
  worker: {
    format: "es",
  },
});
