// A selected satellite marks its passes on the clock deck's timeline, and anything else
// selected after it clears them (useSelectedEntity).

import { openApp, selectSatellite } from "../support/app";
import { expect, test } from "../support/test";
import { openMenu } from "../support/ui";

test.use({ viewport: { width: 1280, height: 800 } });

const QUERY = "tags=&sats=ISS+(ZARYA)&gs=48.1372,11.5756,Munich";

test("a ground station selected after a satellite leaves no pass marks", async ({ page }) => {
  await openApp(page, QUERY);
  const marks = page.locator(".deck .pass");

  await selectSatellite(page, "ISS (ZARYA)");
  await expect(marks.first()).toBeAttached();

  await page.evaluate(() => window.cc!.sats.groundStations[0]!.select());
  await expect(page.locator(".entity-info-panel")).toContainText("Munich");
  await expect(marks).toHaveCount(0);
});

// Prediction answers off-thread, and the info panel's refresh never runs while paused.
test("a satellite selected on a paused clock marks its passes once they are predicted", async ({ page }) => {
  await openApp(page, QUERY);
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));

  await selectSatellite(page, "ISS (ZARYA)");

  await expect(page.locator(".deck .pass").first()).toBeAttached();
});

test("removing the station on a paused clock clears the marks", async ({ page }) => {
  await openApp(page, QUERY);
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));
  const marks = page.locator(".deck .pass");
  await selectSatellite(page, "ISS (ZARYA)");
  await expect(marks.first()).toBeAttached();

  await openMenu(page, "Locations");
  await page.locator(".gsList__remove").first().click();

  await expect(marks).toHaveCount(0);
});
