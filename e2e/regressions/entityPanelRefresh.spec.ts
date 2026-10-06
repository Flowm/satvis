// Once a real second at any clock speed, never while paused
// (CesiumCallbackHelper.createThrottledTimeCallback).

import type { Page } from "@playwright/test";

import { openApp, selectSatellite, waitTicks } from "../support/app";
import { expect, test } from "../support/test";

/**
 * Counts the ticks on which the panel text changed, over at least `minMs` and
 * `minTicks`, so a per-frame refresh stands out from a once-a-second one.
 */
const watchPanel = (page: Page, minMs: number, minTicks: number) =>
  page.evaluate(
    (minimum) =>
      new Promise<{ changes: number; ticks: number; ms: number }>((resolve) => {
        const panel = document.querySelector<HTMLElement>(".entity-info-panel")!;
        const start = performance.now();
        let text = panel.innerText;
        let changes = 0;
        let ticks = 0;
        const off = window.cc!.viewer.clock.onTick.addEventListener(() => {
          // Vue patched the DOM after the previous tick, so this compares whole frames.
          ticks += 1;
          if (panel.innerText !== text) {
            text = panel.innerText;
            changes += 1;
          }
          const ms = performance.now() - start;
          if (ms >= minimum.ms && ticks >= minimum.ticks) {
            off();
            resolve({ changes, ticks, ms });
          }
        });
      }),
    { ms: minMs, ticks: minTicks },
  );

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 700 });
  await openApp(page, "tags=&sats=ISS+(ZARYA)");
  await selectSatellite(page, "ISS (ZARYA)");
  await expect(page.locator(".entity-info-panel")).toBeVisible();
});

test("the panel changes about once a second at any clock speed", async ({ page }) => {
  for (const multiplier of [1, 60, 3600, 86400]) {
    await page.evaluate((value) => (window.cc!.viewer.clock.multiplier = value), multiplier);
    await waitTicks(page, 2);
    const { changes, ticks, ms } = await watchPanel(page, 4000, 20);
    const report = `${changes} changes in ${ticks} ticks over ${Math.round(ms)} ms at ${multiplier}×`;
    // At most once a second. At least once every two: the refresh lands on a frame,
    // and at a runner's 420 ms a frame the first one past a second is 1.26 s in.
    expect.soft(changes, report).toBeLessThanOrEqual(Math.ceil(ms / 1000));
    expect.soft(changes, report).toBeGreaterThanOrEqual(Math.floor(ms / 2000));
  }
});

test("the panel stays still while paused, and catches up once after a jump", async ({ page }) => {
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));
  await waitTicks(page, 2);
  expect((await watchPanel(page, 1500, 10)).changes).toBe(0);

  const before = await page.locator(".entity-info-panel").innerText();
  await page.evaluate(() => {
    const { clock } = window.cc!.viewer;
    const JulianDate = clock.currentTime.constructor as typeof clock.currentTime.constructor & {
      addMinutes: (time: unknown, minutes: number, result: unknown) => typeof clock.currentTime;
    };
    clock.currentTime = JulianDate.addMinutes(clock.currentTime, 30, clock.currentTime.clone());
  });
  await expect.poll(() => page.locator(".entity-info-panel").innerText(), { timeout: 10_000 }).not.toBe(before);
  expect((await watchPanel(page, 1500, 10)).changes).toBe(0);
});
