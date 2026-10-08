// The url carries the whole scene (ADR 0001).

import type { Page } from "@playwright/test";

import { openApp } from "../support/app";
import { collectConsoleErrors, expect, test } from "../support/test";
import { menuSwitch, openMenu, searchSatellites } from "../support/ui";

const ISS = "ISS (ZARYA)";
const MUNICH = { latitude: 48.1372, longitude: 11.5756 };

test.use({ geolocation: MUNICH, permissions: ["geolocation"], viewport: { width: 1280, height: 800 } });

/** What the scene shows, read from the menus a visitor would look at. */
async function sceneState(page: Page) {
  await openMenu(page, "Locations");
  const station = page.locator(".gsList__row").first();
  const state = {
    satellites: await page.evaluate(() => window.cc!.sats.activeSatellites.map((sat) => sat.props.name).toSorted()),
    station: [await station.getByLabel("Name").inputValue(), await station.getByLabel("Latitude").inputValue(), await station.getByLabel("Longitude").inputValue()],
    groundTrack: false,
    basemap: "",
    scene: "",
  };
  await openMenu(page, "Components");
  state.groundTrack = await menuSwitch(page, "Ground track").locator("input").isChecked();
  await openMenu(page, "Map");
  state.basemap = await page.locator('input[name="basemap"]:checked').inputValue();
  await openMenu(page, "Globe");
  state.scene = (await menuSwitch(page, "2D").locator("input").isChecked()) ? "2D" : "other";
  return state;
}

test("a scene set up through the menus survives the trip through its url", async ({ page, browser }) => {
  await openApp(page, "", { live: true });

  await searchSatellites(page, "ISS");
  await page.getByRole("checkbox", { name: `Toggle ${ISS}` }).click();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("checkbox", { name: "Toggle group Weather" }).click();
  await expect.poll(() => page.evaluate(() => window.cc!.sats.activeSatellites.map((sat) => sat.props.name))).toEqual([ISS]);

  await openMenu(page, "Locations");
  await page.getByRole("button", { name: "My location" }).click();
  const station = page.locator(".gsList__row").first();
  await expect(station.getByLabel("Latitude")).toHaveValue(String(MUNICH.latitude));
  await station.getByLabel("Name").fill("Munich");
  await station.getByLabel("Name").press("Enter");

  await openMenu(page, "Components");
  await menuSwitch(page, "Ground track").click();
  await openMenu(page, "Map");
  await menuSwitch(page, "OSM").click();
  await openMenu(page, "Globe");
  await menuSwitch(page, "2D").click();
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.scene.mode)).toBe(2);

  const before = await sceneState(page);
  expect(before).toEqual({ satellites: [ISS], station: ["Munich", "48.1372", "11.5756"], groundTrack: true, basemap: "OSM", scene: "2D" });
  const link = new URL(page.url());
  for (const parameter of ["sats", "tags", "gs", "elements", "layers", "scene"]) {
    expect(link.searchParams.has(parameter), `the link carries ${parameter}`).toBe(true);
  }

  // A fresh browser: no storage, no location.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const shared = await context.newPage();
  const errors = collectConsoleErrors(shared);
  await openApp(shared, link.search.slice(1), { live: true });
  expect(await sceneState(shared)).toEqual(before);
  expect(new URL(shared.url()).search, "the url is not rewritten on the way in").toBe(link.search);
  expect(errors).toEqual([]);
  await context.close();
});
