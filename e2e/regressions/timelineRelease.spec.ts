// The throw was the last move's speed, kept while the pointer rested, so a stopped
// drag still flung the clock (releaseVelocity).

import type { Page } from "@playwright/test";

import { openApp, waitTicks } from "../support/app";
import { expect, test } from "../support/test";
import { openClockDeck } from "../support/ui";

test.use({ viewport: { width: 1280, height: 800 } });

const clockMs = (page: Page) => page.evaluate(() => Date.parse(window.cc!.viewer.clock.currentTime.toString()));

/**
 * Drags the paused timeline 150 px (an hour) to the right, holding `holdMs` before
 * the release, and returns how far the clock moved once it settled, in minutes.
 *
 * Dispatched in the page, not through Playwright's mouse: that waits for the page to
 * take each step, and at a runner's frame a second every release read as held.
 */
async function dragAnHour(page: Page, { holdMs }: { holdMs: number }): Promise<number> {
  const before = await clockMs(page);
  await page.evaluate(async (hold) => {
    const timeline = document.querySelector<HTMLElement>('[aria-label="Timeline"]')!;
    // A synthetic pointer id was never seen by the browser, so capturing it throws.
    timeline.setPointerCapture = () => {};
    timeline.releasePointerCapture = () => {};
    const box = timeline.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2 - 75, box.top + box.height / 2];
    const fire = (type: string, at: number) =>
      timeline.dispatchEvent(new PointerEvent(type, { clientX: at, clientY: y, pointerId: 7, pointerType: "mouse", isPrimary: true, bubbles: true }));
    fire("pointerdown", x);
    for (let step = 1; step <= 5; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      fire("pointermove", x + step * 30);
    }
    // Even a zero timeout yields to a frame, which on SwiftShader outlasts the hold
    // threshold: a release while moving goes out in the same task.
    if (hold > 0) {
      await new Promise((resolve) => setTimeout(resolve, hold));
    }
    fire("pointerup", x + 150);
  }, holdMs);
  // Settled: unmoved across three frames, since a coast advances on every one.
  await expect
    .poll(async () => {
      const first = await clockMs(page);
      await waitTicks(page, 3);
      return first === (await clockMs(page));
    })
    .toBe(true);
  return (before - (await clockMs(page))) / 60_000;
}

test("a drag held still before release does not coast; one let go moving does", async ({ page }) => {
  await openApp(page, "");
  await openClockDeck(page);
  await page.locator(".deck").getByRole("button", { name: "Pause", exact: true }).click();

  expect(await dragAnHour(page, { holdMs: 300 })).toBeCloseTo(60, 0);
  expect(await dragAnHour(page, { holdMs: 0 })).toBeGreaterThan(61);
});
