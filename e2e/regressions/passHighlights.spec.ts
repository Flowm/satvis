// A selected satellite marks its passes on the clock deck's timeline. Every satellite
// hears a selection change, so the one losing it must clear its marks without wiping
// the next one's (usePassHighlights).

import { openApp, selectSatellite } from "../support/app";
import { expect, test } from "../support/test";

test("a ground station selected after a satellite leaves no pass marks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, "tags=&sats=ISS+(ZARYA)&gs=48.1372,11.5756,Munich");
  const marks = page.locator(".deck .pass");

  await selectSatellite(page, "ISS (ZARYA)");
  await expect(marks.first()).toBeAttached();

  await page.evaluate(() => window.cc!.sats.groundStations[0]!.select());
  await expect(page.locator(".entity-info-panel")).toContainText("Munich");
  await expect(marks).toHaveCount(0);
});
