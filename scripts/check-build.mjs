// Two rules that exist only in the generated dist/sw.js (AGENTS.md, Gotchas): a data url
// opened in the address bar must not get the app shell, and nothing from Cesium ion or
// Google's tile hosts may be cached.

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

test("nothing from Cesium ion or Google's tile hosts is cached", () => {
  // Cesium's terms allow caching only as a general mechanism; Google's Map Tiles policies restrict it.
  for (const host of ["ion.cesium.com", "assets.ion.cesium.com", "api.cesium.com", "googleapis"]) {
    assert.equal(sw.includes(host), false, host);
  }
});
