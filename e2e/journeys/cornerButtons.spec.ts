// The top-right column, which the native app's corner matches button for button.

import type { Page } from "@playwright/test";

import { hitTest, openApp, selectSatellite, steady, waitForSky } from "../support/app";
import { expect, test } from "../support/test";
import { closeMenuPanel, DEVICES, openMenu } from "../support/ui";

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

    test("the corner stops tracking, flies home and shows the UI the menu hid", async ({ page }) => {
      await openApp(page, `tags=&sats=${encodeURIComponent(ISS)}&elements=Point,Label&track=${encodeURIComponent(ISS)}`);
      await expect.poll(() => corner(page)).toEqual(["Home view", "Stop tracking"]);

      await page.getByRole("button", { name: "Stop tracking" }).click();
      await expect.poll(() => page.evaluate(() => window.cc!.viewer.trackedEntity === undefined)).toBe(true);
      await expect.poll(() => corner(page)).toEqual(["Home view"]);
      await expect.poll(() => new URL(page.url()).searchParams.get("track")).toBeNull();
      // Back to the view tracking began from, the default one over 15° E 25° N.
      await expect.poll(() => cameraAt(page), { timeout: 10_000 }).toEqual([15, 25]);

      // Rounded, the eased flight reads 15° E 25° N before it lands, and would undo the turn.
      await steady(page, () => page.evaluate(() => window.cc!.viewer.camera.positionWC.toString()));
      await page.evaluate(() => window.cc!.viewer.camera.rotateLeft(1));
      expect(await cameraAt(page)).not.toEqual([15, 25]);
      await page.getByRole("button", { name: "Home view" }).click();
      await expect.poll(() => cameraAt(page), { timeout: 10_000 }).toEqual([15, 25]);

      // The Graphics panel's first row; the corner holds Show UI alone until it is pressed,
      // and the panel comes back closed.
      await openMenu(page, "Graphics");
      await page.getByRole("region", { name: "Graphics" }).getByRole("button", { name: "Hide UI" }).click();
      await expect.poll(() => corner(page)).toEqual(["Show UI"]);
      await expect(page.locator("#toolbarLeft")).toBeHidden();
      await page.getByRole("button", { name: "Show UI" }).click();
      await expect.poll(() => corner(page)).toEqual(["Home view"]);
      await expect(page.locator("#toolbarLeft")).toBeVisible();
      await expect(page.getByRole("region", { name: "Graphics" })).toBeHidden();
    });

    test("the column hides under the info panel, whose own buttons stay reachable", async ({ page }) => {
      await openApp(page, `tags=&sats=${encodeURIComponent(ISS)}&elements=Point,Label&track=${encodeURIComponent(ISS)}`);
      await expect.poll(() => corner(page)).toEqual(["Home view", "Stop tracking"]);
      await selectSatellite(page, ISS);
      const panel = page.locator(".entity-info-panel");
      await expect(panel).toBeVisible();
      await expect(page.locator("#toolbarRight")).toBeHidden();
      await expect
        .poll(() => hitTest(page, { track: ".entity-info-panel [aria-label='Track entity']", close: ".entity-info-panel [aria-label='Close']" }))
        .toEqual({ track: "clickable", close: "clickable" });

      await panel.getByRole("button", { name: "Close" }).click();
      await expect(panel).toBeHidden();
      await expect(page.locator("#toolbarRight")).toBeVisible();
    });

    test("in the sky view the globe button leaves it, above the compass", async ({ page }) => {
      await openApp(page, "scene=Sky&gs=48.1400,11.5800");
      await waitForSky(page);
      // Chromium has DeviceOrientationEvent, and localhost is a secure context.
      await expect.poll(() => corner(page)).toEqual(["Leave the sky view", "Aim by compass"]);

      await page.getByRole("button", { name: "Leave the sky view" }).click();
      await expect.poll(() => page.evaluate(() => window.cc!.skyView.active)).toBe(false);
      await expect.poll(() => corner(page)).toEqual(["Home view"]);
    });

    test("a menu panel stops short of the corner, which stays in reach", async ({ page }) => {
      await openApp(page, "tags=", { satellites: false });
      for (const title of ["Components", "Map", "Locations"]) {
        await openMenu(page, title);
        await expect
          .poll(() => hitTest(page, { home: "#toolbarRight [aria-label='Home view']", close: `[aria-label='${title}'] [aria-label='Close panel']` }), { message: title })
          .toEqual({ home: "clickable", close: "clickable" });
        await closeMenuPanel(page, title);
      }
    });
  });
}

test.describe("phone", () => {
  test.use(DEVICES.phone);

  // A sheet in the native app, so nothing to stop short of there.
  test("a wide panel covers the corner, which hides under it", async ({ page }) => {
    await openApp(page, "tags=", { satellites: false });
    await openMenu(page, "Satellites");
    await expect(page.getByRole("region", { name: "Satellites" })).toBeVisible();
    await expect(page.locator("#toolbarRight")).toBeHidden();
    await closeMenuPanel(page, "Satellites");
    await expect(page.locator("#toolbarRight")).toBeVisible();
  });
});

test.describe("desktop", () => {
  test.use(DEVICES.desktop);

  test("focus moves from Hide UI to Show UI, and on to the Menu button", async ({ page }) => {
    await openApp(page, "tags=", { satellites: false });
    await openMenu(page, "Graphics");
    await page.getByRole("region", { name: "Graphics" }).getByRole("button", { name: "Hide UI" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Show UI" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".menuColumn__toggle")).toBeFocused();
  });

  test("Escape shows the hidden UI", async ({ page }) => {
    await openApp(page, "tags=", { satellites: false });
    await openMenu(page, "Graphics");
    await page.getByRole("region", { name: "Graphics" }).getByRole("button", { name: "Hide UI" }).click();
    await expect(page.locator("#toolbarLeft")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.locator("#toolbarLeft")).toBeVisible();
  });
});
