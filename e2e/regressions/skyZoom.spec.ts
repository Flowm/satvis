import type { Page } from "@playwright/test";

import { WHEEL_ZOOM_RATE } from "../../src/modules/skyGestures";
import { canvasBox, openApp, waitForSky } from "../support/app";
import { expect, test } from "../support/test";
import { touchscreen } from "../support/ui";

const view = (page: Page) => page.evaluate(() => ({ fovy: window.cc!.skyView.fovy, aim: { ...window.cc!.skyView.aim } }));

test.beforeEach(async ({ page }) => {
  await openApp(page, "scene=Sky&gs=48.1400,11.5800");
  await waitForSky(page);
  const { cx, cy } = await canvasBox(page);
  await page.mouse.move(cx, cy);
  expect((await view(page)).fovy).toBe(75);
});

test("equal wheel notches zoom by a constant ratio about a fixed aim", async ({ page }) => {
  const start = await view(page);
  const fovys = [start.fovy];
  for (let notch = 0; notch < 3; notch += 1) {
    await page.mouse.wheel(0, -200);
    await expect.poll(async () => (await view(page)).fovy).toBeLessThan(fovys.at(-1)!);
    fovys.push((await view(page)).fovy);
  }
  for (let index = 1; index < fovys.length; index += 1) {
    expect(fovys[index]! / fovys[index - 1]!).toBeCloseTo(Math.exp(-200 * WHEEL_ZOOM_RATE), 9);
  }
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await view(page)).fovy).toBeCloseTo(75, 9);
  expect((await view(page)).aim).toEqual(start.aim);
});

test("the wheel clamps the field of view and reads line deltas", async ({ page }) => {
  await page.mouse.wheel(0, -5000);
  await expect.poll(async () => (await view(page)).fovy).toBe(10);
  await page.mouse.wheel(0, 5000);
  await expect.poll(async () => (await view(page)).fovy).toBe(100);
  // Chromium rounds a fractional delta, so back near 75°, not onto it.
  await page.mouse.wheel(0, Math.log(75 / 100) / WHEEL_ZOOM_RATE);
  await expect.poll(async () => (await view(page)).fovy).toBeCloseTo(75, 4);

  // Firefox scrolls in lines (deltaMode 1), which skyGestures counts as 16 px.
  await page.evaluate(() => window.cc!.viewer.scene.canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -3, deltaMode: 1, cancelable: true })));
  expect((await view(page)).fovy).toBeCloseTo(75 * Math.exp(-48 * WHEEL_ZOOM_RATE), 4);
});

test("a pinch scales the field of view by the finger spread, and the last finger drags on without a jump", async ({ page }) => {
  const start = await view(page);
  const box = await canvasBox(page);
  const { cx, cy } = box;
  const touch = await touchscreen(page);

  await touch("touchStart", [[0, cx - 50, cy]]);
  await touch("touchStart", [
    [0, cx - 50, cy],
    [1, cx + 50, cy],
  ]);
  await touch("touchMove", [
    [0, cx - 100, cy],
    [1, cx + 100, cy],
  ]);
  await expect.poll(async () => (await view(page)).fovy).toBeCloseTo(37.5, 6);
  await touch("touchMove", [
    [0, cx - 150, cy],
    [1, cx + 150, cy],
  ]);
  // From the gesture start, not per move: three times the spread is a third.
  await expect.poll(async () => (await view(page)).fovy).toBeCloseTo(25, 6);
  expect((await view(page)).aim).toEqual(start.aim);

  // Lift the second finger, then drag the first 40 px.
  await touch("touchEnd", [[1, cx + 150, cy]]);
  await touch("touchMove", [[0, cx - 130, cy]]);
  await touch("touchMove", [[0, cx - 110, cy]]);
  // Chrome delivers touch moves on the next frame, so poll.
  const perPixel = 25 / box.height;
  await expect.poll(async () => (await view(page)).aim.azimuth).toBeCloseTo(start.aim.azimuth - 40 * perPixel, 6);
  await touch("touchEnd", [[0, cx - 110, cy]]);
});
