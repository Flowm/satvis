// The Graphics panel's frame rate reaches Cesium's render loop, with its headroom
// (`targetFrameRateFor`), and rides the url as the other Graphics settings do.

import type { Page } from "@playwright/test";

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { menuSwitch, openMenu } from "../support/ui";

const targetFrameRate = (page: Page) => page.evaluate(() => window.cc!.viewer.targetFrameRate ?? null);

test("a frame rate caps Cesium's loop and stays in the url", async ({ page }) => {
  await openApp(page, "framerate=max");
  expect(await targetFrameRate(page)).toBeNull();

  await openMenu(page, "Graphics");
  await expect(menuSwitch(page, "Max").locator("input")).toBeChecked();
  await menuSwitch(page, "30 fps").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("framerate")).toBe("30");
  expect(await targetFrameRate(page)).toBeCloseTo(31.5);

  // The default, as on iOS, and nothing in the url.
  await menuSwitch(page, "60 fps").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("framerate")).toBeNull();
  expect(await targetFrameRate(page)).toBeCloseTo(63);
});
