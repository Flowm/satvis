// The Graphics panel's frame rate reaches Cesium's render loop, with its headroom
// (`targetFrameRateFor`), and rides the url as the other Graphics settings do. On a
// phone it is in view as the panel opens, as on iOS.

import type { Page } from "@playwright/test";

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES, menuSwitch, openMenu } from "../support/ui";

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

test.describe("phone", () => {
  test.use(DEVICES.phone);

  test("the frame rate is in view without scrolling", async ({ page }) => {
    await openApp(page, "tags=", { satellites: false });
    await openMenu(page, "Graphics");
    const body = page.getByRole("region", { name: "Graphics" }).locator(".toolbarPanel__body");
    const frameRate = body.getByRole("radiogroup", { name: "Frame rate" });
    await expect(frameRate).toBeVisible();
    const [bodyBox, frameRateBox] = await Promise.all([body.boundingBox(), frameRate.boundingBox()]);
    expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
    expect(frameRateBox!.y + frameRateBox!.height).toBeLessThanOrEqual(bodyBox!.y + bodyBox!.height);
  });
});
