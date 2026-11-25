// On a phone the info panel's tabs shrank to fit and cut their labels to "O…", "Space…",
// "Ima…". The row scrolls instead. The fixtures give no satellite five tabs, so the ISS's
// four, with their pass count, stand in on a 320 px phone.

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES, showInfo } from "../support/ui";

test.use({ ...DEVICES.phone, viewport: { width: 320, height: 640 } });

test("the info panel's tab labels stay whole on a phone", async ({ page }) => {
  await openApp(page, "gs=48.1372,11.5756,Munich");
  await showInfo(page, "ISS (ZARYA)");
  const tabs = page.locator(".entity-info-panel").getByRole("tab");
  await expect(tabs).toHaveText(["Orbit", "Spacecraft", "Instruments", /Passes\s*\d+/]);
  const cut = await tabs.evaluateAll((elements) =>
    elements.filter((tab) => [...tab.querySelectorAll<HTMLElement>("span")].some((span) => span.scrollWidth > span.clientWidth)).map((tab) => tab.textContent),
  );
  expect(cut).toEqual([]);
  // The last tab scrolls into reach.
  const passes = tabs.last();
  await passes.click();
  await expect(passes).toHaveAttribute("aria-selected", "true");
});
