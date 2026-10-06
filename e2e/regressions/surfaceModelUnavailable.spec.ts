// OSM Buildings: Google Photorealistic applies in the sky view only, so in 3D it
// loads nothing that could fail.

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { menuSwitch, openMenu, toasts } from "../support/ui";

// The failed loads are logged on purpose: the surface model, and the World Terrain it imposes.
test.use({ viewport: { width: 1280, height: 800 }, allowConsoleErrors: /failed to load|ERR_BLOCKED_BY_CLIENT/ });

test("an unavailable surface model reverts to None and says so once", async ({ page }) => {
  // The harness cuts off every host but localhost, ion's included.
  await openApp(page, "");
  await openMenu(page, "Map");
  await menuSwitch(page, "OsmBuildings").click();

  await expect(toasts(page, "OsmBuildings unavailable")).toHaveCount(1);
  // The surface radios are the unnamed ones.
  await expect(page.locator('input[type="radio"][value="None"]:not([name])')).toBeChecked();
  await expect(page.locator('input[name="terrain"][value="None"]')).toBeChecked();
  expect(new URL(page.url()).searchParams.get("surface")).toBeNull();
  expect(await page.evaluate(() => window.cc!.surface.active)).toBeFalsy();
});
