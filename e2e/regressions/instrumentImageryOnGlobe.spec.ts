// GIBS and EUMETView are stubbed: the layer's frames are fixed here, and every tile is
// one transparent pixel. The fixture's GOES 19 and Meteosat-12 carry the imagery
// manifest's entries for their imagers, with what lets the globe draw them (ADR 0020).

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

test("a EUMETView layer is drawn by its WMS, at the frame for the clock", async ({ page }) => {
  const tiles: URLSearchParams[] = [];
  const stubEumetView = async () => {
    await page.route("https://view.eumetsat.int/**", (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("request") === "GetCapabilities") {
        expect(url.pathname).toBe("/geoserver/mtg_fd/rgb_geocolour/ows");
        return route.fulfill({
          contentType: "text/xml",
          body: `<Layer><Layer><Name>rgb_geocolour</Name><EX_GeographicBoundingBox>
            <westBoundLongitude>-81.28</westBoundLongitude><eastBoundLongitude>81.28</eastBoundLongitude>
            <southBoundLatitude>-77.35</southBoundLatitude><northBoundLatitude>77.36</northBoundLatitude>
            </EX_GeographicBoundingBox>
            <Dimension name="time" units="ISO8601">2026-10-01T00:00:00.000Z/2026-10-05T23:50:00.000Z/PT10M</Dimension></Layer></Layer>`,
        });
      }
      tiles.push(url.searchParams);
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    });
  };
  await openApp(page, "time=2026-10-03T15:07Z&imagery=eumetview:mtg_fd:rgb_geocolour", { setup: stubEumetView });
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));

  const asked = (name: string) => [...new Set(tiles.map((tile) => tile.get(name)))];
  await expect.poll(() => asked("time")).toEqual(["2026-10-03T15:00:00Z"]);
  expect(asked("layers")).toEqual(["mtg_fd:rgb_geocolour"]);
  expect(asked("request")).toEqual(["GetMap"]);
  expect(asked("format")).toEqual(["image/png"]);
  expect(asked("width")).toEqual(["512"]);
  // Nothing east of the disc, which ends at 81.28°: the tiles there are never asked for.
  expect(tiles.every((tile) => Number(tile.get("bbox")!.split(",")[0]) < 81.28)).toBe(true);

  tiles.length = 0;
  await setClock(page, "2026-10-03T16:07:00Z");
  await expect.poll(() => asked("time")).toEqual(["2026-10-03T16:00:00Z"]);

  await openMenu(page, "Map");
  await expect(menuSwitch(page, "GeoColour · METEOSAT-12 (MTG-I1)")).toBeChecked();
});

// A layer that follows the clock is on the globe only once its service has listed its frames.
test("instrument imagery lies over a basemap that arrives after it, and under the overlays", async ({ page }) => {
  const VIIRS = "VIIRS_NOAA20_CorrectedReflectance_TrueColor";
  let listViirs!: () => void;
  const viirsListed = new Promise<void>((resolve) => (listViirs = resolve));
  const stubGibs = async () => {
    await page.route("https://gibs.earthdata.nasa.gov/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.endsWith("/all.xml")) {
        return route.fulfill({ contentType: "image/png", body: PIXEL });
      }
      const daily = path.includes(VIIRS);
      if (daily) {
        await viirsListed;
      }
      const domain = daily ? "2026-09-01/2026-10-05/P1D" : "2026-10-01T00:00:00Z/2026-10-05T23:50:00Z/PT10M";
      return route.fulfill({ contentType: "text/xml", body: `<Domains><DimensionDomain><Domain>${domain}</Domain></DimensionDomain></Domains>` });
    });
  };
  await openApp(page, `time=2026-10-03T15:07Z&layers=VIIRS,Tiles&imagery=gibs:${LAYER}`, { setup: stubGibs });

  /** The globe's layers bottom first, by GIBS layer; "grid" for the tile grid, which has no address. */
  const order = () =>
    page.evaluate(() => {
      const layers = window.cc!.viewer.imageryLayers;
      return Array.from({ length: layers.length }, (_, index) => {
        const provider = layers.get(index).imageryProvider as { url?: string } | undefined;
        return /best\/([^/]+)\//.exec(provider?.url ?? "")?.[1] ?? "grid";
      });
    });
  await expect.poll(order).toEqual([LAYER, "grid"]);
  listViirs();
  await expect.poll(order).toEqual([VIIRS, LAYER, "grid"]);
});
