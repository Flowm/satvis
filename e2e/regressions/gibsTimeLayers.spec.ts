// GIBS is stubbed: each layer's time domain is fixed here, and every tile is one
// transparent pixel.

import type { Page } from "@playwright/test";

import { openApp, PIXEL, setClock, waitTicks } from "../support/app";
import { expect, test } from "../support/test";
import { menuSwitch, openMenu } from "../support/ui";

const DOMAINS: Record<string, string> = {
  "GOES-East_ABI_Band13_Clean_Infrared": "2026-10-01T00:00:00Z/2026-10-05T23:50:00Z/PT10M",
  VIIRS_SNPP_CorrectedReflectance_TrueColor: "2026-09-01/2026-10-05/P1D",
};

/** Stubs GIBS, and records the `{Time}` of every tile and the domain requests since the last `clear`. */
function stubGibs(page: Page) {
  const tiles: { layer: string; time: string }[] = [];
  let domainRequests = 0;
  const install = async () => {
    await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/all.xml")) {
        domainRequests += 1;
        const layer = path.split("/")[5]!;
        return route.fulfill({ contentType: "text/xml", body: `<Domains><DimensionDomain><Domain>${DOMAINS[layer]}</Domain></DimensionDomain></Domains>` });
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

test("the layers request the frame for the clock, and nothing once removed", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  const gibs = stubGibs(page);
  await openApp(page, "tags=&layers=VIIRS,GOES-IR&time=2026-10-03T15:07Z", { setup: gibs.install, satellites: false });
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));

  expect(gibs.times("GOES-East_ABI_Band13_Clean_Infrared")).toEqual(["2026-10-03T15:00:00Z"]);
  expect(gibs.times("VIIRS_SNPP_CorrectedReflectance_TrueColor")).toEqual(["2026-10-03"]);

  gibs.clear();
  await setClock(page, "2026-10-03T16:07:00Z");
  await expect.poll(() => gibs.times("GOES-East_ABI_Band13_Clean_Infrared")).toEqual(["2026-10-03T16:00:00Z"]);

  // Past the end of the domain the latest frame holds.
  gibs.clear();
  await setClock(page, "2026-10-09T12:00:00Z");
  await expect.poll(() => gibs.times("VIIRS_SNPP_CorrectedReflectance_TrueColor")).toEqual(["2026-10-05"]);

  // NaturalEarth replaces VIIRS as the base map; GOES-IR is an overlay.
  const tickListeners = () => page.evaluate(() => window.cc!.viewer.clock.onTick.numberOfListeners);
  const listenersWithLayers = await tickListeners();
  await openMenu(page, "Map");
  await menuSwitch(page, "NaturalEarth").click();
  await menuSwitch(page, "GOES-IR").click();
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.imageryLayers.length)).toBe(1);
  expect(new URL(page.url()).searchParams.get("layers")).toBeNull();
  // Each layer kept the viewer's clock in step with one listener.
  expect(await tickListeners()).toBe(listenersWithLayers - 2);

  gibs.clear();
  await setClock(page, "2026-10-02T09:00:00Z");
  await waitTicks(page, 10);
  expect(gibs.requests()).toBe(0);
});
