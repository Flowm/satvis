// A frame change used to empty the layer's tile cache (Cesium's time-dynamic reload), so
// the globe tiles a zoom made while the new frame loaded had no parent tile to draw and
// showed the basemap. GIBS is stubbed, with a delay so the new frame is still loading
// when the zoom lands.

import type { Page } from "@playwright/test";

import { openApp, PIXEL, setClock } from "../support/app";
import { expect, test } from "../support/test";

const LAYER = "GOES-East_ABI_GeoColor";

/** Rendered globe tiles that draw nothing of any layer over the basemap. */
const tilesWithoutImagery = (page: Page) =>
  page.evaluate(() => {
    // Cesium's own bookkeeping: a tile draws a layer through an entry with a ready image, its own or a parent's.
    const viewer = window.cc!.viewer as unknown as {
      imageryLayers: { get(index: number): unknown };
      scene: { globe: { _surface: { _tilesToRender: { data: { imagery: { readyImagery?: { imageryLayer: unknown } }[] } }[] } } };
    };
    const basemap = viewer.imageryLayers.get(0);
    return viewer.scene.globe._surface._tilesToRender.filter(
      (tile) => !tile.data.imagery.some((entry) => entry.readyImagery !== undefined && entry.readyImagery.imageryLayer !== basemap),
    ).length;
  });

test("zooming while a new frame loads keeps the old frame on the globe", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const times = new Set<string>();
  const stubGibs = async () => {
    await page.route("https://gibs.earthdata.nasa.gov/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/all.xml")) {
        return route.fulfill({
          contentType: "text/xml",
          body: "<Domains><DimensionDomain><Domain>2026-10-01T00:00:00Z/2026-10-05T23:50:00Z/PT10M</Domain></DimensionDomain></Domains>",
        });
      }
      times.add(decodeURIComponent(path.split("/")[6]!));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return route.fulfill({ contentType: "image/png", body: PIXEL }).catch(() => {});
    });
  };
  await openApp(page, `time=2026-10-03T15:07Z&imagery=gibs:${LAYER}`, { setup: stubGibs });
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.imageryLayers.length)).toBe(2);
  await expect.poll(() => tilesWithoutImagery(page)).toBe(0);

  await setClock(page, "2026-10-03T16:07:00Z");
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, -240);
  const holes: number[] = [];
  for (let sample = 0; sample < 20; sample += 1) {
    // eslint-disable-next-line no-await-in-loop -- one sample after another, while the frame loads
    holes.push(await tilesWithoutImagery(page));
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(100);
  }
  expect(Math.max(...holes)).toBe(0);

  // The new frame replaces the old one once it is whole.
  await expect.poll(() => [...times]).toContain("2026-10-03T16:00:00Z");
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.imageryLayers.length)).toBe(2);
});
