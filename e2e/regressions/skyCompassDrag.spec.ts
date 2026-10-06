// ADR 0004. A pinch once ended compass aiming on its first pixel: it marked itself
// "not a tap" by bumping the drag counter that the handover reads.

import type { Page } from "@playwright/test";

import { openApp, waitForSky } from "../support/app";
import { expect, test } from "../support/test";
import { menuSwitch, openMenu } from "../support/ui";

// The headless shell asks DeviceOrientationEvent.requestPermission; without these it is denied.
test.use({ viewport: { width: 1000, height: 800 }, permissions: ["accelerometer", "gyroscope", "magnetometer"] });

const sky = (page: Page) => page.evaluate(() => ({ aiming: window.cc!.skyInteraction.orientationActive, aim: { ...window.cc!.skyView.aim }, fovy: window.cc!.skyView.fovy }));

/** A phone held still, pointing west-south-west and down: an absolute reading every 100 ms. */
const startSensor = (page: Page) =>
  page.evaluate(() => {
    setInterval(() => window.dispatchEvent(new DeviceOrientationEvent("deviceorientationabsolute", { alpha: 100, beta: 60, gamma: -5, absolute: true })), 100);
  });

const compassSwitch = (page: Page) => menuSwitch(page, "Use compass").locator("input");

let centre: { x: number; y: number };

test.beforeEach(async ({ page }) => {
  await openApp(page, "scene=Sky&gs=48.1372,11.5756,Munich");
  await waitForSky(page);
  const box = (await page.locator("#cesiumContainer canvas").boundingBox())!;
  centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await startSensor(page);
  await openMenu(page, "View");
});

async function aimByCompass(page: Page) {
  await menuSwitch(page, "Use compass").click();
  const toasts = page.getByRole("region", { name: /Notifications/ }).getByRole("listitem");
  await expect(toasts.filter({ hasText: "Aiming by compass" })).toHaveCount(1);
  await expect(compassSwitch(page)).toBeChecked();
  expect((await sky(page)).aiming).toBe(true);
}

async function drag(page: Page, dx: number, dy: number) {
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + dx, centre.y + dy, { steps: 4 });
  await page.mouse.up();
}

test("a nudge leaves the compass aiming; a drag takes the aim back, levels it and stays", async ({ page }) => {
  await aimByCompass(page);
  const sensed = await sky(page);
  expect(sensed.aim.roll).not.toBe(0);

  // 3 + 4 px: inside the 8 px tap slop.
  await drag(page, 3, 4);
  expect((await sky(page)).aiming).toBe(true);

  await drag(page, 40, 40);
  await expect.poll(async () => (await sky(page)).aiming).toBe(false);
  const taken = await sky(page);
  expect(taken.aim.roll).toBe(0);
  expect(taken.aim.azimuth).not.toBeCloseTo(sensed.aim.azimuth, 1);
  await expect(compassSwitch(page)).not.toBeChecked();

  // The sensor keeps reporting; nothing pulls the view back to it.
  await page.waitForTimeout(500);
  expect((await sky(page)).aim).toEqual(taken.aim);
});

test("a drag during the sensor probe cancels quietly", async ({ page }) => {
  await menuSwitch(page, "Use compass").click();
  // Inside the 1.2 s probe.
  await expect(compassSwitch(page)).toBeDisabled();
  expect((await sky(page)).aiming).toBe(true);
  await drag(page, 40, 40);
  await expect(compassSwitch(page)).toBeEnabled();
  await expect(compassSwitch(page)).not.toBeChecked();
  expect((await sky(page)).aiming).toBe(false);
  expect((await sky(page)).aim.roll).toBe(0);
  await expect(page.getByText("Compass aiming unavailable")).toHaveCount(0);
});

test("a pinch zooms without ending compass aiming, and its last finger must really drag", async ({ page }) => {
  await aimByCompass(page);
  await page.evaluate(() => (window.cc!.viewer.selectedEntity = undefined));
  const before = await sky(page);
  const { x, y } = centre;
  // CDP keys fingers by `id`: touchEnd releases the points it lists.
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: [id: number, x: number, y: number][]) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([id, px, py]) => ({ id, x: px, y: py })) });

  await touch("touchStart", [[0, x - 50, y]]);
  await touch("touchStart", [
    [0, x - 50, y],
    [1, x + 50, y],
  ]);
  await touch("touchMove", [
    [0, x - 100, y],
    [1, x + 100, y],
  ]);
  await expect.poll(async () => (await sky(page)).fovy).toBeCloseTo(before.fovy / 2, 6);
  expect((await sky(page)).aiming).toBe(true);

  // One finger left, moved 3 px: still a tap's worth.
  await touch("touchEnd", [[1, x + 100, y]]);
  await touch("touchMove", [[0, x - 97, y]]);
  await page.waitForTimeout(300);
  expect((await sky(page)).aiming).toBe(true);
  expect(await page.evaluate(() => window.cc!.viewer.selectedEntity)).toBeUndefined();

  await touch("touchMove", [[0, x, y]]);
  await expect.poll(async () => (await sky(page)).aiming).toBe(false);
  await touch("touchEnd", [[0, x, y]]);
});
