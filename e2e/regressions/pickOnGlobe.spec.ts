// Pick on globe: the controller reports a click that hits the globe, and sceneSync turns
// it into a station and ends pick mode, which also takes the crosshair off the canvas.

import { canvasBox, openApp } from "../support/app";
import { expect, test } from "../support/test";
import { openMenu } from "../support/ui";

test("a click in pick mode adds a station where it hit, once", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, "tags=", { satellites: false });
  await openMenu(page, "Locations");
  const rows = page.locator(".gsList__row");
  await expect(rows).toHaveCount(0);
  const canvas = page.locator("#cesiumContainer canvas");

  await page.getByRole("button", { name: "Pick on globe" }).click();
  await expect(canvas).toHaveCSS("cursor", "crosshair");

  // The default view frames the whole globe in the middle of the page.
  const { cx, cy } = await canvasBox(page);
  await page.mouse.click(cx, cy);

  await expect(rows).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Pick on globe" })).toBeVisible();
  await expect(canvas).not.toHaveCSS("cursor", "crosshair");

  // Out of pick mode, a click selects but places nothing.
  await page.mouse.click(cx, cy);
  await expect(rows).toHaveCount(1);
});
