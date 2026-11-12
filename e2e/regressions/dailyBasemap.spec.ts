// The Map panel's daily basemap (VIIRS) follows the clock frame by frame. GIBS is
// stubbed: the layer's time domain is fixed here, and every tile is one transparent pixel.

import type { Page } from "@playwright/test";

import { openApp, PIXEL, setClock, waitTicks } from "../support/app";
import { expect, test } from "../support/test";
import { menuSwitch, openMenu } from "../support/ui";

const VIIRS = "VIIRS_NOAA20_CorrectedReflectance_TrueColor";
const DOMAIN = "2026-09-01/2026-10-05/P1D";

/** Stubs GIBS, and records the `{Time}` of every tile and the domain requests since the last `clear`. */
function stubGibs(page: Page) {
  const tiles: { layer: string; time: string }[] = [];
  let domainRequests = 0;
  const install = async () => {
    await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/all.xml")) {
        domainRequests += 1;
        return route.fulfill({ contentType: "text/xml", body: `<Domains><DimensionDomain><Domain>${DOMAIN}</Domain></DimensionDomain></Domains>` });
      }
      // /wmts/epsg3857/best/<layer>/default/<time>/<matrix set>/<z>/<y>/<x>.<ext>
      const [, , , , layer, , time] = path.split("/");
      tiles.push({ layer: layer!, time: decodeURIComponent(time!) });
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    });
  };
  return {
    install,
    times: (layer: string) => [...new Set(tiles.filter((tile) => tile.layer === layer).map((tile) => tile.time))],
    requests: () => tiles.length + domainRequests,
    clear: () => {
      tiles.length = 0;
      domainRequests = 0;
    },
  };
}

test("the daily basemap requests the frame for the clock, and nothing once removed", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const gibs = stubGibs(page);
  await openApp(page, "tags=&layers=VIIRS&time=2026-10-03T15:07Z", { setup: gibs.install, satellites: false });
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));

  // One layer again once a new day's has replaced the old one's.
  const settled = () => expect.poll(() => page.evaluate(() => window.cc!.viewer.imageryLayers.length)).toBe(1);
  await expect.poll(() => gibs.times(VIIRS)).toEqual(["2026-10-03"]);
  await settled();

  gibs.clear();
  await setClock(page, "2026-10-01T16:07:00Z");
  await expect.poll(() => gibs.times(VIIRS)).toEqual(["2026-10-01"]);
  await settled();

  // Past the end of the domain the latest finished day holds.
  gibs.clear();
  await setClock(page, "2026-10-09T12:00:00Z");
  await expect.poll(() => gibs.times(VIIRS)).toEqual(["2026-10-04"]);
  await settled();

  // NaturalEarth replaces VIIRS as the base map.
  const tickListeners = () => page.evaluate(() => window.cc!.viewer.clock.onTick.numberOfListeners);
  const listenersWithLayers = await tickListeners();
  await openMenu(page, "Map");
  await menuSwitch(page, "Natural Earth").click();
  await expect.poll(() => page.evaluate(() => (window.cc!.viewer.imageryLayers.get(0).imageryProvider as { url?: string } | undefined)?.url ?? "")).toContain("NaturalEarth");
  expect(await page.evaluate(() => window.cc!.viewer.imageryLayers.length)).toBe(1);
  expect(new URL(page.url()).searchParams.get("layers")).toBeNull();
  // The layer followed the viewer's clock with one listener.
  expect(await tickListeners()).toBe(listenersWithLayers - 1);

  gibs.clear();
  await setClock(page, "2026-10-02T09:00:00Z");
  await waitTicks(page, 10);
  expect(gibs.requests()).toBe(0);
});
