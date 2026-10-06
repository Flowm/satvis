// The url is the app's state (ADR 0001): set a scene up through the menus, send the
// link, and whoever opens it in a fresh browser sees the same scene.

import type { Page } from "@playwright/test";

import { openApp } from "../support/app";
import { collectConsoleErrors, expect, test } from "../support/test";

const ISS = "ISS (ZARYA)";
const MUNICH = { latitude: 48.1372, longitude: 11.5756 };

test.use({ geolocation: MUNICH, permissions: ["geolocation"], viewport: { width: 1280, height: 800 } });

const menu = (page: Page, entry: string) => page.getByRole("button", { name: entry, exact: true }).click();
const toggle = (page: Page, label: string) => page.locator("label.toolbarSwitch", { hasText: new RegExp(`^\\s*${label}\\s*$`) });

/** What the scene shows, read from the menus a visitor would look at. */
async function sceneState(page: Page) {
  await menu(page, "Ground station");
  const station = page.locator(".gsList__row").first();
  const state = {
    satellites: await page.evaluate(() => window.cc!.sats.activeSatellites.map((sat) => sat.props.name).toSorted()),
    station: [await station.getByLabel("Name").inputValue(), await station.getByLabel("Latitude").inputValue(), await station.getByLabel("Longitude").inputValue()],
    groundTrack: false,
    basemap: "",
    scene: "",
  };
  await menu(page, "Components");
  state.groundTrack = await toggle(page, "Ground track").locator("input").isChecked();
  await menu(page, "Map");
  state.basemap = await page.locator('input[name="basemap"]:checked').inputValue();
  await menu(page, "View");
  state.scene = (await toggle(page, "2D").locator("input").isChecked()) ? "2D" : "other";
  return state;
}

test("a scene set up through the menus survives the trip through its url", async ({ page, browser }) => {
  await openApp(page, "", { live: true });

  // Only the ISS: find it, then drop the default weather group.
  await menu(page, "Satellites");
  await page.getByPlaceholder("Search satellites").fill("ISS");
  await page.getByRole("checkbox", { name: `Toggle ${ISS}` }).click();
  await page.getByRole("button", { name: "Clear search" }).click();
  await page.getByRole("checkbox", { name: "Toggle group Weather" }).click();
  await expect.poll(() => page.evaluate(() => window.cc!.sats.activeSatellites.map((sat) => sat.props.name))).toEqual([ISS]);

  // A ground station where the browser says we are, named.
  await menu(page, "Ground station");
  await page.getByRole("button", { name: "My location" }).click();
  const station = page.locator(".gsList__row").first();
  await expect(station.getByLabel("Latitude")).toHaveValue(String(MUNICH.latitude));
  await station.getByLabel("Name").fill("Munich");
  await station.getByLabel("Name").press("Enter");

  await menu(page, "Components");
  await toggle(page, "Ground track").click();
  await menu(page, "Map");
  await toggle(page, "OSM").click();
  await menu(page, "View");
  await toggle(page, "2D").click();
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.scene.mode)).toBe(2);

  const before = await sceneState(page);
  expect(before).toEqual({ satellites: [ISS], station: ["Munich", "48.1372", "11.5756"], groundTrack: true, basemap: "OSM", scene: "2D" });
  const link = new URL(page.url());
  for (const parameter of ["sats", "tags", "gs", "elements", "layers", "scene"]) {
    expect(link.searchParams.has(parameter), `the link carries ${parameter}`).toBe(true);
  }

  // Someone else opens it: a fresh browser, no storage, no location.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const shared = await context.newPage();
  const errors = collectConsoleErrors(shared);
  await openApp(shared, link.search.slice(1), { live: true });
  expect(await sceneState(shared)).toEqual(before);
  expect(new URL(shared.url()).search, "the url is not rewritten on the way in").toBe(link.search);
  expect(errors).toEqual([]);
  await context.close();
});
