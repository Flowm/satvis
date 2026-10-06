import type { Page } from "@playwright/test";

import { FIXTURE_TIME, openApp } from "../support/app";
import { expect, test } from "../support/test";
import { openClockDeck } from "../support/ui";

// Reduced motion turns off the timeline's coast, which is integrated per frame: at a
// runner's frame a second it overshot the hour by 12 minutes. timelineRelease.spec.ts
// covers the coast.
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

  // 600×: ten minutes a second.
  await deck.getByRole("button", { name: "Set playback speed", exact: true }).click();
  await deck.getByRole("radio", { name: /^600×/ }).click();
  await expect(deck.getByRole("radio", { name: /^600×/ })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.clock.multiplier)).toBe(600);
  await deck.getByRole("button", { name: "Play", exact: true }).click();
  const playing = await clockMs(page);
  await expect.poll(async () => (await clockMs(page)) - playing, { message: "the clock runs at 600×" }).toBeGreaterThan(5 * 60_000);

  // Back to now from a paused 600× must play at 1×, or the clock leaves the present again.
  await deck.getByRole("button", { name: "Pause", exact: true }).click();
  await deck.getByRole("button", { name: "Show timeline", exact: true }).click();
  await deck.getByRole("button", { name: "Back to now", exact: true }).click();
  expect(await page.evaluate(() => window.cc!.viewer.clock.multiplier)).toBe(1);
  await expect(deck.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(live).toBeVisible();
  await expect.poll(() => pinned(page)).toBeNull();
  expect(Math.abs((await clockMs(page)) - Date.parse(FIXTURE_TIME))).toBeLessThan(5 * 60_000);
  await page.waitForTimeout(2000);
  await expect(live).toBeVisible();
  expect(pinned(page)).toBeNull();
});
