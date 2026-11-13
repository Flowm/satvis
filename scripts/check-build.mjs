// Rules that exist only in the generated dist/sw.js: a data url opened in the address bar
// must not get the app shell (vite.config.ts says why), the link preview is not precached,
// and nothing from Cesium ion or Google's tile hosts may be cached.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const SW = new URL("../dist/sw.js", import.meta.url);

const sw = existsSync(SW) ? readFileSync(SW, "utf8") : "";

/** The `navigateFallbackDenylist` workbox wrote, as live RegExps. */
function denylist() {
  const literal = /denylist:(\[[^\]]*\])/.exec(sw)?.[1];
  assert.ok(literal, "dist/sw.js has a navigation denylist");
  return new Function(`return ${literal}`)();
}

/** Whether a navigation to `pathname` would get index.html from the service worker. */
const servesShell = (pathname) => !denylist().some((pattern) => pattern.test(pathname));

test("dist/sw.js exists", () => {
  assert.ok(sw, "run `pnpm build` first");
});

test("data, api and Cesium urls are never answered with the app shell", () => {
  // The bug: `.json` was missing from the extension list, so /api/groups.json got index.html.
  for (const pathname of [
    "/api/groups.json",
    "/api/gp/weather.json",
    "/data/gp/weather.json",
    "/data/imagery/NaturalEarthII/0/0/0.webp",
    "/cesium/Workers/createVerticesFromHeightmap.js",
    "/.well-known/apple-app-site-association",
  ]) {
    assert.equal(servesShell(pathname), false, pathname);
  }
});

// So does a typo: offline the app beats the 404 page, which only the Worker's router serves.
test("the app's own routes still get the shell offline", () => {
  for (const pathname of ["/", "/ot", "/embedded", "/about"]) {
    assert.equal(servesShell(pathname), true, pathname);
  }
});

test("the link preview is not precached", () => {
  // Only scrapers fetch it, so no visitor should download it with the app.
  assert.equal(sw.includes("og-image"), false);
});

test("nothing from Cesium ion or Google's tile hosts is cached", () => {
  // Cesium's terms allow caching only as a general mechanism; Google's Map Tiles policies restrict it.
  for (const host of ["ion.cesium.com", "assets.ion.cesium.com", "api.cesium.com", "googleapis"]) {
    assert.equal(sw.includes(host), false, host);
  }
});

test("imagery is cached at a dated frame, never at the latest or a day still filling in", () => {
  const at = sw.indexOf('cacheName:"imagery-frame-cache"');
  assert.ok(at > 0, "dist/sw.js caches imagery frames");
  const from = sw.lastIndexOf("registerRoute(", at) + "registerRoute(".length;
  const matches = new Function(`return ${sw.slice(from, sw.lastIndexOf(",new ", at))}`)();
  const cached = (url) => matches({ url: new URL(url) });
  const day = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const gibs = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default";
  const eumetView = "https://view.eumetsat.int/geoserver/ows?service=WMS&request=GetMap&layers=mtg_fd%3Argb_geocolour";
  for (const url of [
    `${gibs}/${day(0)}T15:30:00Z/GoogleMapsCompatible_Level7/3/2/4.png`,
    `${gibs}/${day(3)}/GoogleMapsCompatible_Level9/3/2/4.jpg`,
    `${eumetView}&time=2026-11-13T15%3A30%3A00Z&bbox=0,0,45,45`,
  ]) {
    assert.equal(cached(url), true, url);
  }
  for (const url of [
    `${gibs}/default/GoogleMapsCompatible_Level7/3/2/4.png`,
    `${gibs}/${day(1)}/GoogleMapsCompatible_Level9/3/2/4.jpg`,
    `${gibs.replace("/default", "")}/default/GoogleMapsCompatible_Level7/all/all.xml`,
    `${eumetView}&bbox=0,0,45,45`,
    "https://view.eumetsat.int/geoserver/mtg_fd/rgb_geocolour/ows?service=WMS&version=1.3.0&request=GetCapabilities",
  ]) {
    assert.equal(cached(url), false, url);
  }
});
