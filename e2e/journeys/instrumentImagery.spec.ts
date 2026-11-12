import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES, showInfo } from "../support/ui";

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
  });
}
