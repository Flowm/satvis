// The top-right column, which the native app's corner matches button for button.

import type { Page } from "@playwright/test";

import { openApp, waitForSky } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES } from "../support/ui";

const ISS = "ISS (ZARYA)";

/** The column's buttons by their accessible names, top to bottom. */
const corner = (page: Page) => page.locator("#toolbarRight button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));

/** Degrees under the camera. */
const cameraAt = (page: Page) =>
  page.evaluate(() => {
    const { longitude, latitude } = window.cc!.viewer.camera.positionCartographic;
    return [Math.round((longitude * 180) / Math.PI), Math.round((latitude * 180) / Math.PI)];
  });

for (const [device, options] of Object.entries(DEVICES)) {
  test.describe(device, () => {
    test.use(options);

    test("the corner stops tracking, flies home and hides the UI", async ({ page }) => {
      await openApp(page, `tags=&sats=${encodeURIComponent(ISS)}&elements=Point,Label&track=${encodeURIComponent(ISS)}`);
      await expect.poll(() => corner(page)).toEqual(["Hide UI", "Home view", "Stop tracking"]);

      await page.getByRole("button", { name: "Stop tracking" }).click();
      await expect.poll(() => page.evaluate(() => window.cc!.viewer.trackedEntity === undefined)).toBe(true);
      await expect.poll(() => corner(page)).toEqual(["Hide UI", "Home view"]);
      await expect.poll(() => new URL(page.url()).searchParams.get("track")).toBeNull();
      // Back to the view tracking began from, the default one over 15° E 25° N.
      await expect.poll(() => cameraAt(page), { timeout: 10_000 }).toEqual([15, 25]);

      await page.evaluate(() => window.cc!.viewer.camera.rotateLeft(1));
      expect(await cameraAt(page)).not.toEqual([15, 25]);
      await page.getByRole("button", { name: "Home view" }).click();
      await expect.poll(() => cameraAt(page), { timeout: 10_000 }).toEqual([15, 25]);

      await page.getByRole("button", { name: "Hide UI" }).click();
      await expect.poll(() => corner(page)).toEqual(["Show UI"]);
      await expect(page.locator("#toolbarLeft")).toBeHidden();
      await page.getByRole("button", { name: "Show UI" }).click();
      await expect.poll(() => corner(page)).toEqual(["Hide UI", "Home view"]);
      await expect(page.locator("#toolbarLeft")).toBeVisible();
    });

    test("in the sky view the globe button leaves it, above the compass", async ({ page }) => {
      await openApp(page, "scene=Sky&gs=48.1400,11.5800");
      await waitForSky(page);
      // Chromium has DeviceOrientationEvent, and localhost is a secure context.
      await expect.poll(() => corner(page)).toEqual(["Hide UI", "Leave the sky view", "Aim by compass"]);

      await page.getByRole("button", { name: "Leave the sky view" }).click();
      await expect.poll(() => page.evaluate(() => window.cc!.skyView.active)).toBe(false);
      await expect.poll(() => corner(page)).toEqual(["Hide UI", "Home view"]);
    });
  });
}
