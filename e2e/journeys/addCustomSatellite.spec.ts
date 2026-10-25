import { openApp, waitForScene } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES, openMenu } from "../support/ui";

/** A sun-sync orbit with its epoch at the fixture time, 2026 day 278 at noon. */
const TLE = ["MY CUBESAT", "1 99001U 26001A   26278.50000000  .00002284  00000-0  41838-4 0  9992", "2 99001  97.5000 229.0798 0005166 124.8351 329.3296 15.20000000145658"].join(
  "\n",
);

for (const [device, options] of Object.entries(DEVICES)) {
  test.describe(device, () => {
    test.use(options);

    test("a pasted TLE joins the catalog and the globe, and stays in this browser until removed", async ({ page }) => {
      await openApp(page, "");
      await openMenu(page, "Satellites");
      await page.getByRole("button", { name: "Browse and filter the catalog" }).click();
      const sheet = page.getByRole("region", { name: "Satellite catalog" });
      const total = Number((await sheet.locator(".catalogSheet__of").textContent())?.replace(/\D/g, ""));

      await sheet.getByRole("button", { name: "Add a custom satellite" }).click();
      const dialog = page.getByRole("dialog", { name: "Custom satellites" });
      const box = dialog.getByRole("textbox", { name: "Element sets" });
      // A catalog satellite's name is refused; a name of its own is offered.
      const taken = await page.evaluate(() => window.cc!.sats.catalog.entries[0]!.name);
      await box.fill(TLE.replace("MY CUBESAT", taken));
      await expect(dialog.getByText(`${taken} is the name of a catalog satellite; rename it`)).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Add to the globe" })).toBeDisabled();
      await box.fill(TLE);
      await expect(dialog.getByRole("list", { name: "Ready to add" })).toContainText("MY CUBESAT");
      await dialog.getByRole("button", { name: "Add to the globe" }).click();

      // One satellite added alone opens its info.
      await expect(dialog).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.cc!.viewer.selectedEntity?.name)).toBe("MY CUBESAT");
      expect(new URL(page.url()).searchParams.get("sats")).toBe("MY CUBESAT");
      if (device !== "phone") {
        // A phone closes the sheet to show the info panel.
        await expect(sheet.locator(".catalogSheet__of")).toHaveText(`of ${total + 1}`);
      }

      // A reload finds it in this browser's storage.
      await page.reload();
      await waitForScene(page);
      await expect.poll(() => page.evaluate(() => window.cc!.sats.activeSatellites.some((sat) => sat.props.name === "MY CUBESAT"))).toBe(true);

      await openMenu(page, "Satellites");
      await page.getByRole("button", { name: "Browse and filter the catalog" }).click();
      await sheet.getByRole("button", { name: "Add a custom satellite" }).click();
      await dialog.getByRole("button", { name: "Remove MY CUBESAT" }).click();
      await expect(dialog.getByRole("list", { name: "Custom satellites in this browser" })).toBeHidden();
      await expect.poll(() => new URL(page.url()).searchParams.get("sats")).toBeNull();
      expect(await page.evaluate(() => window.cc!.sats.catalog.getByName("MY CUBESAT") !== undefined)).toBe(false);
      // Escape closes the dialog alone.
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(sheet).toBeVisible();
    });
  });
}
