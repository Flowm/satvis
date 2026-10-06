// When does the ISS pass over me? Add a station where the browser says we are, open
// the ISS, pick a pass on its timeline, and jump the clock to it.

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { addStationHere, openMenu } from "../support/ui";

const ISS = "ISS (ZARYA)";

test.use({ geolocation: { latitude: 48.1372, longitude: 11.5756 }, permissions: ["geolocation"], viewport: { width: 1280, height: 800 } });

test("the ISS lists its passes over my location, and a pass can be jumped to", async ({ page }) => {
  await openApp(page, "", { live: true });
  await addStationHere(page, "Munich");

  await openMenu(page, "Satellites");
  await page.getByPlaceholder("Search satellites").fill("ISS");
  await page.getByRole("button", { name: `Show info for ${ISS}` }).click();

  const panel = page.locator(".entity-info-panel");
  const passesTab = panel.getByRole("tab", { name: /Passes/ });
  // The badge counts the passes once they are computed.
  await expect(passesTab).toHaveText(/Passes\s*\d+/);
  await passesTab.click();
  await expect(panel.locator(".hero__label")).toContainText("Next pass");
  const rows = panel.locator("tbody tr");
  expect(await rows.count()).toBeGreaterThan(0);

  // A bar on the timeline marks its row in the table.
  const bars = panel.locator(".timeline__pass:not(.is-past)");
  await bars.nth(1).click();
  await expect(panel.locator("tbody tr.is-picked")).toHaveCount(1);

  // Its start time sets the clock, and the ISS is overhead. The deck no longer
  // reads live; the url does not pin the time (sceneSync: only the url and the deck do).
  const picked = panel.locator("tbody tr.is-picked");
  const startMs = Number(await picked.getAttribute("data-start-ms"));
  await picked.locator("a.link").click();
  await expect.poll(() => page.evaluate(() => Date.parse(window.cc!.viewer.clock.currentTime.toString()))).toBeGreaterThanOrEqual(startMs);
  await expect(panel.locator(".hero__label")).toContainText("Overhead now");
  await expect(page.getByRole("img", { name: "Live" })).toBeHidden();
});
