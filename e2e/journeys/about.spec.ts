import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES } from "../support/ui";

for (const [device, options] of Object.entries(DEVICES)) {
  test.describe(device, () => {
    test.use(options);

    test("the menu's last entry opens the about dialog, and Escape returns to it", async ({ page }) => {
      await openApp(page, "", { satellites: false });

      const expand = page.getByRole("button", { name: "Open menu" });
      if (await expand.isVisible()) {
        await expand.click();
      }
      const entry = page.locator("#menuColumnList > :last-child");
      await expect(entry).toHaveAccessibleName("About");
      // The only link crawlers find to /about.
      await expect(entry).toHaveAttribute("href", "/about");
      await expect(page.locator("#toolbarRight").getByRole("link")).toHaveCount(0);

      await entry.click();
      const dialog = page.getByRole("dialog", { name: "About Satvis" });
      await expect(dialog.locator(".about--dialog")).toBeVisible();
      await expect(dialog.locator(".about--dialog")).not.toContainText("Loading");
      expect(new URL(page.url()).pathname).toBe("/");

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(entry).toBeFocused();
      // The dialog took the Escape; the column stays open.
      await expect(page.locator("#menuColumnList")).toBeVisible();
    });
  });
}
