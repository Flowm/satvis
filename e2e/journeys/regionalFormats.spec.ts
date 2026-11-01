// A German browser reads numbers and dates in its region's conventions (ADR 0015).

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { openMenu } from "../support/ui";

test.use({ locale: "de-DE", viewport: { width: 1280, height: 800 } });

test("the clock's day and a station's coordinates follow the region, and a typed comma is a decimal", async ({ page }) => {
  await openApp(page, "gs=48.1372,11.5756,Munich");
  await expect(page.locator(".stamp__date")).toHaveText("Mon 05 Oct UTC");

  await openMenu(page, "Locations");
  const station = page.locator(".gsList__row").first();
  await expect(station.getByLabel("Latitude")).toHaveValue("48,1372");
  await expect(station.getByLabel("Longitude")).toHaveValue("11,5756");

  await station.getByLabel("Latitude").fill("47,5");
  await station.getByLabel("Latitude").press("Enter");
  await expect.poll(() => new URL(page.url()).searchParams.get("gs")).toBe("47.5000,11.5756,Munich");
  await expect(station.getByLabel("Latitude")).toHaveValue("47,5");

  // A pair pasted into one field is not a coordinate, and the field keeps what it had.
  await station.getByLabel("Longitude").fill("48.1372, 11.5756");
  await station.getByLabel("Longitude").press("Enter");
  await expect(station.getByLabel("Longitude")).toHaveValue("11,5756");
  expect(new URL(page.url()).searchParams.get("gs")).toBe("47.5000,11.5756,Munich");
});
