// GIBS is stubbed: the layer's time domain is fixed here, and every tile is one
// transparent pixel. The fixture's GOES 19 carries the imagery manifest's entry for its
// ABI, with the tile set that lets the globe draw it (ADR 0020).

import { openApp, PIXEL, setClock } from "../support/app";
import { expect, test } from "../support/test";
import { menuSwitch, openMenu, showInfo } from "../support/ui";

const LAYER = "GOES-East_ABI_GeoColor";

test("an instrument's imagery is shown on the globe from its tab, follows the clock, and is taken off in the Map panel", async ({ page }) => {
  const times: string[] = [];
  const stubGibs = async () => {
    await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/all.xml")) {
        return route.fulfill({
          contentType: "text/xml",
          body: "<Domains><DimensionDomain><Domain>2026-10-01T00:00:00Z/2026-10-05T23:50:00Z/PT10M</Domain></DimensionDomain></Domains>",
        });
      }
      // /wmts/epsg3857/best/<layer>/default/<time>/<matrix set>/<z>/<y>/<x>.<ext>
      const [, , , , layer, , time, matrixSet] = path.split("/");
      expect(layer).toBe(LAYER);
      expect(matrixSet).toBe("GoogleMapsCompatible_Level7");
      expect(path.endsWith(".png")).toBe(true);
      times.push(decodeURIComponent(time!));
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    });
  };
  await openApp(page, "time=2026-10-03T15:07Z", { setup: stubGibs });
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));
  await showInfo(page, "GOES 19");

  const panel = page.locator(".entity-info-panel");
  await panel.getByRole("tab", { name: "Instruments" }).click();
  const show = panel.getByRole("region", { name: "ABI" }).getByRole("button", { name: "Show GeoColor on the globe" });
  await expect(show).toHaveAttribute("aria-pressed", "false");
  await show.click();
  await expect(show).toHaveAttribute("aria-pressed", "true");

  await expect.poll(() => [...new Set(times)]).toEqual(["2026-10-03T15:00:00Z"]);
  expect(new URL(page.url()).searchParams.get("imagery")).toBe(`gibs:${LAYER}`);
  // Over the basemap.
  expect(await page.evaluate(() => window.cc!.viewer.imageryLayers.length)).toBe(2);

  times.length = 0;
  await setClock(page, "2026-10-03T16:07:00Z");
  await expect.poll(() => [...new Set(times)]).toEqual(["2026-10-03T16:00:00Z"]);

  await openMenu(page, "Map");
  await menuSwitch(page, "GeoColor · GOES 19").click();
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.imageryLayers.length)).toBe(1);
  expect(new URL(page.url()).searchParams.get("imagery")).toBeNull();
  await expect(show).toHaveAttribute("aria-pressed", "false");
});

// GOES 19 is in no group the default route loads.
test("a link's instrument imagery is drawn once its satellite has loaded", async ({ page }) => {
  const layers = new Set<string>();
  const stubGibs = async () => {
    await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/all.xml")) {
        return route.fulfill({
          contentType: "text/xml",
          body: "<Domains><DimensionDomain><Domain>2026-10-01T00:00:00Z/2026-10-05T23:50:00Z/PT10M</Domain></DimensionDomain></Domains>",
        });
      }
      layers.add(path.split("/")[4]!);
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    });
  };
  await openApp(page, `time=2026-10-03T15:07Z&imagery=gibs:${LAYER}`, { setup: stubGibs });

  await expect.poll(() => [...layers]).toEqual([LAYER]);
  await openMenu(page, "Map");
  await expect(menuSwitch(page, "GeoColor · GOES 19")).toBeChecked();
});
