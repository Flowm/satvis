// The HUD covers the viewport, so a control under it looks right while its clicks are
// swallowed. #app isolates its stacking context, so no z-index lifts Cesium's widgets
// above it. What works: the HUD at z-index 4 with pointer-events none, the entity
// panel at 5, the toolbars at 6 and 7.

import { hitTest, openApp, selectSatellite, waitForSky } from "../support/app";
import { expect, test } from "../support/test";

const CONTROLS = {
  "menu toggle": "#toolbarLeft .menuColumn__toggle",
  "toolbar Map": "#toolbarLeft .menuColumn__item:nth-child(4)",
  "toolbar eye": "#toolbarRight button",
  "cesium credits": ".cesium-credit-logoContainer",
  "clock deck controls": ".cluster",
  "clock deck scale row": ".scale-row",
  "entity info panel": ".entity-info-panel",
};

// At 563 px the expanded column's Map entry lands over the entity panel. At 1106 px
// #toolbarLeft once had pointer-events none.
test("every control takes clicks in the sky view", async ({ page }) => {
  await page.setViewportSize({ width: 563, height: 900 });
  await openApp(page, "scene=Sky&gs=48.1400,11.5800");
  await waitForSky(page);

  await selectSatellite(page);
  await expect(page.locator(".entity-info-panel")).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.locator("#menuColumnList")).toBeVisible();

  const clickable = Object.fromEntries(Object.keys(CONTROLS).map((name) => [name, "clickable"]));
  for (const width of [563, 1000, 1106]) {
    await page.setViewportSize({ width, height: 900 });
    // The clock deck and the credits are placed from resize listeners.
    await expect.poll(() => hitTest(page, CONTROLS), { message: `at ${width} px` }).toEqual(clickable);
  }
});
