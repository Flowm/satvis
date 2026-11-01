// Tracking moved to an entity added since the last render: with the entity update held for
// rendered frames, GeometryVisualizer threw in the tick and the render loop stopped.

import type { Page } from "@playwright/test";

import { openApp, waitTicks } from "../support/app";
import { expect, test } from "../support/test";

/** Adds a point 7,000 km out under the camera, `offset` metres along x, and tracks it at once. */
async function trackNewPoint(page: Page, offset: number): Promise<void> {
  await page.evaluate((dx) => {
    const viewer = window.cc!.viewer;
    const position = viewer.camera.positionWC.clone();
    const scale = 7_000_000 / Math.hypot(position.x, position.y, position.z);
    position.x = position.x * scale + dx;
    position.y *= scale;
    position.z *= scale;
    viewer.trackedEntity = viewer.entities.add({ position, point: { pixelSize: 4 } });
  }, offset);
}

test("tracking an entity added in the same task leaves the render loop running", async ({ page }) => {
  await openApp(page, "tags=", { satellites: false });
  await trackNewPoint(page, 0);
  await waitTicks(page, 5);
  await trackNewPoint(page, 1000);
  await waitTicks(page, 5);
  expect(await page.evaluate(() => window.cc!.viewer.useDefaultRenderLoop)).toBe(true);
});
