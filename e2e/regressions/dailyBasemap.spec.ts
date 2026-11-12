// The Map panel's daily basemap (VIIRS) follows the clock frame by frame. GIBS is
// stubbed: the layer's time domain is fixed here, and every tile is one transparent pixel.

import type { Page } from "@playwright/test";

import { openApp, PIXEL, setClock, waitTicks } from "../support/app";
import { expect, test } from "../support/test";
import { menuSwitch, openMenu } from "../support/ui";

const VIIRS = "VIIRS_NOAA20_CorrectedReflectance_TrueColor";

/** The date `days` from today: GIBS lists up to today, which is still filling in, so the dates here follow the wall clock. */
const day = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const DOMAIN = `2018-01-05/${day(0)}/P1D`;

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
  await openApp(page, `tags=&layers=VIIRS&time=${day(-10)}T15:07Z`, { setup: gibs.install, satellites: false });
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));

  // One layer again, the new day's, once it has replaced the old one's.
  const settled = (shown: string) =>
    expect
      .poll(() =>
        page.evaluate(() => {
          const layers = window.cc!.viewer.imageryLayers;
          return Array.from({ length: layers.length }, (_, index) => (layers.get(index).imageryProvider as unknown as { dimensions: { Time: string } }).dimensions.Time);
        }),
      )
      .toEqual([shown]);
  await expect.poll(() => gibs.times(VIIRS)).toEqual([day(-10)]);
  await settled(day(-10));

  gibs.clear();
  await setClock(page, `${day(-12)}T16:07:00Z`);
  await expect.poll(() => gibs.times(VIIRS)).toEqual([day(-12)]);
  await settled(day(-12));

  // Past the end of the domain the latest finished day holds.
  gibs.clear();
  await setClock(page, `${day(4)}T12:00:00Z`);
  await expect.poll(() => gibs.times(VIIRS)).toEqual([day(-1)]);
  await settled(day(-1));

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
  await setClock(page, `${day(-11)}T09:00:00Z`);
  await waitTicks(page, 10);
  expect(gibs.requests()).toBe(0);
});
