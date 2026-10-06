// Tracking flies the camera to the satellite, then hands over to Cesium's tracking
// without a jump; a newer track supersedes a flight; the clock holds for the flight;
// the sky view takes the camera from one; and stopping flies back to where tracking
// began (trackFlight.ts). Each of these has broken: one probe moved the camera about
// 11,000 km, and chained flights landed more than once.

import type { Page } from "@playwright/test";

import { openApp, selectSatellite, waitTicks } from "../support/app";
import { expect, test } from "../support/test";
import { menuSwitch, openMenu } from "../support/ui";

const ISS = "ISS (ZARYA)";
const CSS = "CSS (TIANHE)";
const QUERY = `tags=&sats=${encodeURIComponent(ISS)},${encodeURIComponent(CSS)}`;

test.use({ viewport: { width: 1000, height: 800 } });

/** Records each change of the tracked entity, with where the camera stood at that moment. */
const recordTracking = (page: Page) =>
  page.evaluate(() => {
    const { viewer } = window.cc!;
    const changes: { name: string | undefined; at: number[] }[] = [];
    viewer.trackedEntityChanged.addEventListener(() => {
      const { x, y, z } = viewer.camera.positionWC;
      changes.push({ name: viewer.trackedEntity?.name, at: [x, y, z] });
    });
    (window as unknown as { trackingChanges: typeof changes }).trackingChanges = changes;
  });

const trackingChanges = (page: Page) => page.evaluate(() => (window as unknown as { trackingChanges: { name: string | undefined; at: number[] }[] }).trackingChanges);

const camera = (page: Page) =>
  page.evaluate(() => {
    const { x, y, z } = window.cc!.viewer.camera.positionWC;
    return [x, y, z];
  });

const metres = (a: number[], b: number[]) => Math.hypot(...a.map((value, index) => value - b[index]!));

const tracked = (page: Page) => page.evaluate(() => window.cc!.viewer.trackedEntity?.name);

/** What the Track button calls: an animated track. */
const track = (page: Page, name: string) => page.evaluate((wanted) => window.cc!.sats.activeSatellites.find((sat) => sat.props.name === wanted)!.track(true), name);

/** Camera still for `ticks` frames: a flight or a jump would move it. */
async function cameraHolds(page: Page, ticks = 20): Promise<number> {
  const before = await camera(page);
  await waitTicks(page, ticks);
  return metres(before, await camera(page));
}

test("track, switch and stop through the panel: no jump on landing, none on a click, back where it began", async ({ page }) => {
  await openApp(page, QUERY);
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));
  await recordTracking(page);
  const start = await camera(page);
  const panel = page.locator(".entity-info-panel");

  await selectSatellite(page, ISS);
  await panel.getByRole("button", { name: "Track entity" }).click();
  await expect.poll(() => tracked(page)).toBe(ISS);
  // Where the flight put the camera is where tracking keeps it: millimetres measured.
  expect(metres((await trackingChanges(page)).at(-1)!.at, await camera(page))).toBeLessThan(1);
  expect(await cameraHolds(page)).toBeLessThan(1);

  // Clicking another satellite opens its panel and leaves the camera and the tracking alone.
  await selectSatellite(page, CSS);
  await expect(panel.locator(".head__name")).toHaveText(CSS);
  expect(await cameraHolds(page, 10)).toBeLessThan(1);
  expect(await tracked(page)).toBe(ISS);

  // Its Track button flies there.
  await panel.getByRole("button", { name: "Track entity" }).click();
  await expect.poll(() => tracked(page)).toBe(CSS);
  expect(await cameraHolds(page)).toBeLessThan(1);

  // Stopping flies back to the view tracking began from.
  await panel.getByRole("button", { name: "Track entity" }).click();
  await expect.poll(() => tracked(page)).toBeUndefined();
  await expect.poll(async () => metres(await camera(page), start), { message: "back where tracking began" }).toBeLessThan(1000);
});

test("a chain of tracks interrupted mid-flight lands once, on the last", async ({ page }) => {
  await openApp(page, QUERY);
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));
  await recordTracking(page);

  await track(page, ISS);
  await track(page, CSS);
  await track(page, ISS);
  await expect.poll(() => tracked(page)).toBe(ISS);
  await waitTicks(page, 20);
  expect((await trackingChanges(page)).map((change) => change.name).filter(Boolean)).toEqual([ISS]);
  expect(await page.evaluate(() => window.cc!.viewer.clock.shouldAnimate)).toBe(false);
});

test("a running clock holds for the flight and runs again on landing", async ({ page }) => {
  await openApp(page, QUERY);
  expect(await page.evaluate(() => window.cc!.viewer.clock.shouldAnimate)).toBe(true);
  await track(page, ISS);
  expect(await page.evaluate(() => window.cc!.viewer.clock.shouldAnimate)).toBe(false);
  await expect.poll(() => tracked(page)).toBe(ISS);
  expect(await page.evaluate(() => window.cc!.viewer.clock.shouldAnimate)).toBe(true);
});

test("the sky view takes the camera from a flight: nothing tracked, the clock running", async ({ page }) => {
  await openApp(page, `${QUERY}&gs=48.1372,11.5756,Munich`);
  await recordTracking(page);
  await openMenu(page, "View");
  await track(page, ISS);
  await menuSwitch(page, "Sky").click();
  await expect.poll(() => page.evaluate(() => window.cc!.skyView.settled)).toBe(true);
  await waitTicks(page, 20);
  expect(await tracked(page)).toBeUndefined();
  expect((await trackingChanges(page)).map((change) => change.name).filter(Boolean)).toEqual([]);
  expect(await page.evaluate(() => window.cc!.viewer.clock.shouldAnimate)).toBe(true);
});
