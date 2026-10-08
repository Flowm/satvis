import type { Page } from "@playwright/test";

import { fixtureGroupCount, openApp, selectSatellite, waitTicks } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES, openMenu } from "../support/ui";

/** A point in the lower right where a press lands on the globe and picks nothing, clear of every panel. */
const bareGlobe = (page: Page) =>
  page.evaluate(() => {
    const { scene } = window.cc!.viewer;
    for (let y = 0.6; y <= 0.9; y += 0.05) {
      for (let x = 0.9; x >= 0.5; x -= 0.05) {
        const at = { x: Math.round(innerWidth * x), y: Math.round(innerHeight * y) };
        if (document.elementFromPoint(at.x, at.y) === scene.canvas && scene.pick(at as Parameters<typeof scene.pick>[0]) === undefined) {
          return at;
        }
      }
    }
    throw new Error("no bare globe in the lower right");
  });

for (const [device, options] of Object.entries(DEVICES)) {
  test.describe(device, () => {
    test.use(options);

    test("a first visit shows the weather satellites on a live clock", async ({ page }) => {
      await openApp(page, "", { live: true });

      const weather = fixtureGroupCount("weather");
      expect(await page.evaluate(() => window.cc!.sats.activeSatellites.length)).toBe(weather);

      await expect(page.getByRole("img", { name: "Live" })).toBeVisible();
      const clockLabel = () => page.locator(".stamp").getAttribute("aria-label");
      const before = await clockLabel();
      await expect.poll(clockLabel, { timeout: 10_000 }).not.toBe(before);

      await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible({ visible: device === "phone" });
      await openMenu(page, "Satellites");
      for (const entry of ["Satellites", "Components", "Map", "Locations", "Globe", "Sky"]) {
        await expect(page.getByRole("button", { name: entry, exact: true })).toBeVisible();
      }
      await expect(page.locator(".browser-summary")).toContainText(`1 group · ${weather} satellites active`);

      // Opening a panel does not change the url.
      await waitTicks(page, 5);
      expect(new URL(page.url()).search).toBe("");

      // A drag turns the globe and keeps the panel; a tap closes it, and on a phone folds the
      // column. A tap that closes the menu and hits nothing keeps the selection.
      await selectSatellite(page);
      const selected = () => page.evaluate(() => window.cc!.viewer.selectedEntity?.name);
      const selection = await selected();
      const catalog = page.getByRole("region", { name: "Satellites" });
      const globe = await bareGlobe(page);
      await page.mouse.move(globe.x, globe.y);
      await page.mouse.down();
      await page.mouse.move(globe.x - 40, globe.y - 40, { steps: 4 });
      await page.mouse.up();
      await expect(catalog).toBeVisible();
      await (device === "phone" ? page.touchscreen.tap(globe.x, globe.y) : page.mouse.click(globe.x, globe.y));
      await expect(catalog).toBeHidden();
      await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible({ visible: device === "phone" });
      expect(await selected()).toBe(selection);
    });
  });
}
