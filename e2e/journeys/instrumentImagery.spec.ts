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
      const abi = panel.getByRole("region", { name: "ABI" });
      const geocolor = abi.getByRole("link", { name: /GeoColor/ });
      await expect(geocolor).toContainText("every 10 min, last 90 days · NASA Worldview");
      await expect(geocolor).toHaveAttribute("href", "https://worldview.earthdata.nasa.gov/?l=GOES-East_ABI_GeoColor");
      await expect(geocolor).toHaveAttribute("target", "_blank");
      // An instrument no layer shows has no list.
      await expect(panel.getByRole("region", { name: "GLM" })).not.toContainText("Imagery");
    });
  });
}
