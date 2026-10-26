// At 820 px a satellite's info, opened from the Satellites panel, opened under that panel,
// which covered its name and tabs: only a phone's width closed it. Whatever would cover
// the info panel closes now, and what stands clear of it stays (Satvis.vue).

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { showInfo } from "../support/ui";

for (const [width, covered] of [
  [820, true],
  [1280, false],
] as const) {
  test(`at ${width} px the Satellites panel ${covered ? "closes for" : "stays beside"} the info panel`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openApp(page, "");
    // Not active yet, so it is selected a frame or more after the click.
    await showInfo(page, "ISS (ZARYA)");
    const info = page.locator(".entity-info-panel");
    await expect(info).toContainText("ISS (ZARYA)");
    await expect(page.getByRole("region", { name: "Satellites" })).toBeVisible({ visible: !covered });
    await expect(page.getByRole("button", { name: "Close menu" })).toBeVisible();
  });
}
