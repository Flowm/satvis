// Leave the present and come back with the clock deck: pause, drag the timeline an
// hour back, speed up, and return to real time and to now. Off the present the url
// pins the time; back on it the url lets go.

import type { Page } from "@playwright/test";

import { FIXTURE_TIME, openApp } from "../support/app";
import { expect, test } from "../support/test";
import { openClockDeck } from "../support/ui";

// Reduced motion turns off the timeline's coast after release. The coast is
// integrated per frame, so at a runner's frame a second it ran 12 minutes past the
// hour; whether it glides belongs to the clock deck's own regression spec.
test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

const clockMs = (page: Page) => page.evaluate(() => Date.parse(window.cc!.viewer.clock.currentTime.toString()));
const pinned = (page: Page) => new URL(page.url()).searchParams.get("time");

test("pause, drag an hour back, speed up, and return to now", async ({ page }) => {
  await openApp(page, "", { live: true });
  await openClockDeck(page);
  const deck = page.locator(".deck");
  const live = deck.getByRole("img", { name: "Live" });
  await expect(live).toBeVisible();

  await deck.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(deck.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  const paused = await clockMs(page);
  await page.waitForTimeout(1500);
  expect(await clockMs(page)).toBe(paused);

  // The timeline is a tape at 150 px an hour: drag it right to go back.
  const timeline = deck.getByRole("group", { name: "Timeline" });
  const box = (await timeline.boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2 - 75, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 75, y, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((paused - (await clockMs(page))) / 60_000)).toBeGreaterThanOrEqual(55);
  expect(Math.round((paused - (await clockMs(page))) / 60_000)).toBeLessThanOrEqual(65);
  await expect(live).toBeHidden();
  await expect.poll(() => pinned(page)).not.toBeNull();

  // Pick 600× on the speed ladder and play: ten minutes pass in a second.
  await deck.getByRole("button", { name: "Set playback speed", exact: true }).click();
  await deck.getByRole("radio", { name: /^600×/ }).click();
  await expect(deck.getByRole("radio", { name: /^600×/ })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.clock.multiplier)).toBe(600);
  await deck.getByRole("button", { name: "Play", exact: true }).click();
  const playing = await clockMs(page);
  await expect.poll(async () => (await clockMs(page)) - playing, { message: "the clock runs at 600×" }).toBeGreaterThan(5 * 60_000);

  // Two resets, one per scale: the ladder's restores the speed, the timeline's the time.
  await deck.getByRole("button", { name: "Back to real time", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.clock.multiplier)).toBe(1);
  await deck.getByRole("button", { name: "Show timeline", exact: true }).click();
  await deck.getByRole("button", { name: "Back to now", exact: true }).click();
  await expect(live).toBeVisible();
  await expect.poll(() => pinned(page)).toBeNull();
  expect(Math.abs((await clockMs(page)) - Date.parse(FIXTURE_TIME))).toBeLessThan(5 * 60_000);
});
