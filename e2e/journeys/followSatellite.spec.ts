import type { Page } from "@playwright/test";

import { openApp, waitTicks } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES, showInfo } from "../support/ui";

const ISS = "ISS (ZARYA)";

/** Metres from the camera to the tracked satellite, and where the satellite is. */
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

      await showInfo(page, ISS);
      // On a phone the catalog and the menu column make way for the info panel.
      await expect(page.getByRole("region", { name: "Satellites" })).toBeVisible({ visible: device === "desktop" });
      await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible({ visible: device === "phone" });

      const panel = page.locator(".entity-info-panel");
      await expect(panel.locator(".head__name")).toHaveText(ISS);
      await expect.poll(() => new URL(page.url()).searchParams.get("sats")).toContain(ISS);

      await expect(panel.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
      await expect(panel.getByRole("row", { name: /Launched/ })).toContainText("1998-11-20");
      await panel.getByRole("tab", { name: /Passes/ }).click();
      await expect(panel).toContainText("No ground station set");
      await panel.getByRole("tab", { name: "Details" }).click();
      await expect(panel.getByRole("row", { name: /Launched/ })).toBeVisible();

      // Pressing the active tab folds the body; pressing it again unfolds it.
      await panel.getByRole("tab", { name: "Details" }).click();
      await expect(panel.getByRole("row", { name: /Launched/ })).toBeHidden();
      await expect(panel.locator(".head__name")).toBeVisible();
      await panel.getByRole("tab", { name: "Details" }).click();
      await expect(panel.getByRole("row", { name: /Launched/ })).toBeVisible();

      // Following: the ISS moves on while the camera keeps its distance.
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

      await panel.getByRole("button", { name: "Track entity" }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("track")).toBeNull();
      expect(await page.evaluate(() => window.cc!.viewer.trackedEntity)).toBeUndefined();

      await panel.getByRole("button", { name: "Close" }).click();
      await expect(panel).toBeHidden();
    });
  });
}
