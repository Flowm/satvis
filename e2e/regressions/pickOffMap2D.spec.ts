// A click that misses the map in 2D: the Viewer's pick fell through to imagery-layer
// features, whose `pickFromRay` throws "Ray intersections are only supported in 3D mode".

import { canvasBox, openApp } from "../support/app";
import { test } from "../support/test";

test("a click and a double-click off the map in 2D throw nothing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, "tags=&scene=2D", { satellites: false });

  // The default 2D view shows the whole map with space above and below it.
  const { x, y, width } = await canvasBox(page);
  await page.mouse.click(x + width / 2, y + 5);
  await page.mouse.dblclick(x + width / 2, y + 5);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
});
