// On a phone a search result was one 28 px line, and its tags cut its name to "NOAA 20 (JP…"
// and themselves to "Active, We…". Its tags go under the name there, as the iOS app's row.

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES, searchSatellites } from "../support/ui";

test.use(DEVICES.phone);

test("a search result shows its whole name on a phone, its tags beneath", async ({ page }) => {
  await openApp(page, "");
  await searchSatellites(page, "NOAA 20");
  const row = page.locator(".browser-row--sat").filter({ has: page.getByRole("checkbox", { name: "Toggle NOAA 20 (JPSS-1)" }) });
  await expect(row).toHaveClass(/browser-row--stacked/);

  const name = row.locator(".browser-label");
  const tags = row.locator(".browser-groups");
  await expect(tags).toContainText("Weather");
  expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await tags.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const [nameBox, tagsBox] = [await name.boundingBox(), await tags.boundingBox()];
  expect(tagsBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height);
});
