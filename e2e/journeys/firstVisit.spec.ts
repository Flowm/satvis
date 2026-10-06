// A first visit: the bare url on a live clock, on a desktop and on a phone. The globe fills with
// the default preset's weather satellites, the menu is there to use, and the url
// stays clean until the visitor changes something.

import { fixtureGroupCount, openApp, waitTicks } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES, openMenu } from "../support/ui";

for (const [device, options] of Object.entries(DEVICES)) {
  test.describe(device, () => {
    test.use(options);

    test("a first visit shows the weather satellites on a live clock", async ({ page }) => {
      await openApp(page, "", { live: true });

      const weather = fixtureGroupCount("weather");
      expect(await page.evaluate(() => window.cc!.sats.activeSatellites.length)).toBe(weather);

      // Live: the deck says so, and the clock moves with the browser's.
      await expect(page.getByRole("img", { name: "Live" })).toBeVisible();
      const clockLabel = () => page.locator(".stamp").getAttribute("aria-label");
      const before = await clockLabel();
      await expect.poll(clockLabel, { timeout: 10_000 }).not.toBe(before);

      // The menu column is open on a desktop and one tap away on a phone, every entry labelled.
      await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible({ visible: device === "phone" });
      await openMenu(page, "Satellites");
      for (const entry of ["Satellites", "Components", "Ground station", "Map", "View"]) {
        await expect(page.getByRole("button", { name: entry, exact: true })).toBeVisible();
      }
      await expect(page.locator(".browser-summary")).toContainText(`1 group · ${weather} satellites active`);

      // Opening a panel is not a change worth a url.
      await waitTicks(page, 5);
      expect(new URL(page.url()).search).toBe("");
    });
  });
}
