// Find a satellite by name, read about it, follow it with the camera and let it go,
// all through the menus and the info panel, on a desktop and on a phone.

import type { Page } from "@playwright/test";

import { openApp, waitTicks } from "../support/app";
import { expect, test } from "../support/test";
import { closeMenuPanel, DEVICES, openMenu } from "../support/ui";

const ISS = "ISS (ZARYA)";

/** Metres from the camera to the tracked satellite, and how far the satellite has come since `from`. */
const trackingGap = (page: Page) =>
  page.evaluate(() => {
    const { viewer } = window.cc!;
    const target = viewer.trackedEntity?.position?.getValue(viewer.clock.currentTime);
    const camera = viewer.camera.positionWC;
    return target ? { gap: Math.hypot(target.x - camera.x, target.y - camera.y, target.z - camera.z), at: [target.x, target.y, target.z] } : undefined;
  });

for (const [device, options] of Object.entries(DEVICES)) {
  test.describe(device, () => {
    test.use(options);

    test("search for the ISS, read its details, and follow it", async ({ page }) => {
      await openApp(page, "", { live: true });

      await openMenu(page, "Satellites");
      await page.getByPlaceholder("Search satellites").fill("ISS");
      await page.getByRole("button", { name: `Show info for ${ISS}` }).click();
      // On a phone the catalog and the menu column stay open over the info panel
      // that just opened: two taps before it can be read.
      if (device === "phone") {
        await closeMenuPanel(page, "Satellites");
        await page.getByRole("button", { name: "Close menu" }).click();
      }

      const panel = page.locator(".entity-info-panel");
      await expect(panel.locator(".head__name")).toHaveText(ISS);
      await expect.poll(() => new URL(page.url()).searchParams.get("sats")).toContain(ISS);

      // Details open first. Without a ground station there are no passes, and the panel says so.
      await expect(panel.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
      await expect(panel.getByRole("row", { name: /Launched/ })).toContainText("1998-11-20");
      await panel.getByRole("tab", { name: /Passes/ }).click();
      await expect(panel).toContainText("No ground station set");
      await panel.getByRole("tab", { name: "Details" }).click();
      await expect(panel.getByRole("row", { name: /Launched/ })).toBeVisible();

      // Track: the camera flies in, then keeps its distance while the ISS moves on.
      await panel.getByRole("button", { name: "Track entity" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("track")).toBe(ISS);
      await expect
        .poll(
          async () => {
            const first = await trackingGap(page);
            await waitTicks(page, 3);
            const second = await trackingGap(page);
            if (!first || !second) {
              return "not tracking";
            }
            const moved = Math.hypot(...second.at.map((value, index) => value - first.at[index]!));
            return moved > 100 && Math.abs(second.gap - first.gap) < 0.01 * first.gap ? "following" : `gap ${Math.round(first.gap)} → ${Math.round(second.gap)} m`;
          },
          { message: "the camera follows the ISS at a steady distance" },
        )
        .toBe("following");

      // The same button lets go.
      await panel.getByRole("button", { name: "Track entity" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("track")).toBeNull();
      expect(await page.evaluate(() => window.cc!.viewer.trackedEntity)).toBeUndefined();

      await panel.getByRole("button", { name: "Close" }).click();
      await expect(panel).toBeHidden();
    });
  });
}
