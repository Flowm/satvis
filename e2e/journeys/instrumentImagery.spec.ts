import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES, openMenu, showInfo } from "../support/ui";

// The fixture's GOES 19 carries the imagery manifest's entry for it (ADR 0019).
for (const [device, options] of Object.entries(DEVICES)) {
  test.describe(device, () => {
    test.use(options);

    test("find the imagery of a weather satellite's imager", async ({ page }) => {
      await openApp(page, "", { live: true });
      await showInfo(page, "GOES 19");

      const panel = page.locator(".entity-info-panel");
      await panel.getByRole("tab", { name: "Instruments" }).click();
      // An instrument no layer shows has no way there.
      await expect(panel.getByRole("region", { name: "GLM" }).getByRole("button", { name: "Imagery of GLM" })).toHaveCount(0);
      await panel.getByRole("button", { name: "Imagery of ABI" }).click();

      await expect(panel.getByRole("tab", { name: "Imagery" })).toHaveAttribute("aria-selected", "true");
      const geocolor = panel.getByRole("article", { name: "ABI GeoColor" });
      await expect(geocolor).toContainText("every 10 min, last 90 days");
      const link = geocolor.getByRole("link", { name: /NASA Worldview/ });
      await expect(link).toHaveAttribute("href", "https://worldview.earthdata.nasa.gov/?l=GOES-East_ABI_GeoColor");
      await expect(link).toHaveAttribute("target", "_blank");
    });

    test("find a satellite's imagery from the catalog", async ({ page }) => {
      await openApp(page, "", { live: true });
      await openMenu(page, "Satellites");
      await page.getByRole("button", { name: "Browse and filter the catalog" }).click();
      const sheet = page.getByRole("region", { name: "Satellite catalog" });
      // A phone shows the list on its own tab.
      if (device === "phone") {
        await sheet.getByRole("tab", { name: /Satellites/ }).click();
      }
      await sheet.getByRole("textbox", { name: "Find a satellite by name or NORAD id" }).fill("GOES 19");
      await sheet.getByRole("button", { name: "Show the imagery of GOES 19" }).click();

      const panel = page.locator(".entity-info-panel");
      await expect(panel.getByRole("tab", { name: "Imagery" })).toHaveAttribute("aria-selected", "true");
      await expect(panel.getByRole("article", { name: "ABI GeoColor" })).toBeVisible();

      // A wide screen keeps the sheet open: a press there unfolds a panel folded since.
      if (device === "desktop") {
        await panel.getByRole("tab", { name: "Imagery" }).click();
        await expect(panel.getByRole("article", { name: "ABI GeoColor" })).toBeHidden();
        await sheet.getByRole("button", { name: "Show the imagery of GOES 19" }).click();
        await expect(panel.getByRole("article", { name: "ABI GeoColor" })).toBeVisible();
      }
    });
  });
}
