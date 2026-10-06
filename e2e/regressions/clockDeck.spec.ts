// The credit line shares the bottom edge with the deck, placed at breakpoints measured
// off the credit box (useClockDeckChrome, main.css).

import { hitTest, openApp } from "../support/app";
import { expect, test } from "../support/test";

/** Each breakpoint and its neighbour, with the credit placement expected there. */
const WIDTHS: [width: number, place: string][] = [
  [375, "clear"],
  [447, "clear"],
  [448, "stacked"],
  [623, "stacked"],
  [624, "beside"],
  [1000, "beside"],
  [1280, "beside"],
];

const CONTROLS = {
  play: ".deck .play",
  clock: ".deck .stamp",
  speed: ".deck .mode",
  "scale row": ".deck .scale-row",
  "credit logo": ".cesium-credit-logoContainer",
  Attribution: ".cesium-credit-expand-link",
};

test("every control and credit takes clicks on both sides of each breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, "");
  for (const [width, place] of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => document.body.dataset.clockDeck), { message: `placement at ${width} px` }).toBe(place);
    // The fullscreen button is hidden below 1000 px, where the scale row would cover it.
    const controls = width >= 1000 ? { ...CONTROLS, fullscreen: ".cesium-viewer-fullscreenContainer button" } : CONTROLS;
    await expect.poll(() => hitTest(page, controls), { message: `at ${width} px` }).toEqual(Object.fromEntries(Object.keys(controls).map((name) => [name, "clickable"])));
  }
});

test("folding keeps the clock still, the ladder keeps the height, and a swipe rests on a rung", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openApp(page, "");
  const deck = page.locator(".deck");
  const stamp = deck.locator(".stamp");
  const play = deck.locator(".play");

  const clockAt = await stamp.boundingBox();
  const playAt = await play.boundingBox();
  await stamp.click();
  await expect(page.locator("body")).toHaveAttribute("data-clock-deck", "folded");
  await expect(play).toHaveCount(0);
  expect(await stamp.boundingBox()).toEqual(clockAt);
  await stamp.click();
  await expect(play).toBeVisible();
  expect(await stamp.boundingBox()).toEqual(clockAt);
  expect(await play.boundingBox()).toEqual(playAt);

  const height = (await deck.boundingBox())!.height;
  await deck.getByRole("button", { name: "Set playback speed", exact: true }).click();
  const ladder = deck.getByRole("radiogroup", { name: "Playback speed" });
  await expect(ladder).toBeVisible();
  expect((await deck.boundingBox())!.height).toBe(height);

  // Two and a half rungs, released while moving: it coasts, then settles.
  const box = (await ladder.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 160, y, { steps: 8 });
  await page.mouse.up();
  const scroll = () => ladder.evaluate((element) => element.scrollLeft);
  await expect
    .poll(
      async () => {
        const first = await scroll();
        await page.waitForTimeout(300);
        return first === (await scroll()) && first % 64 === 0;
      },
      { message: "the ladder rests on a rung" },
    )
    .toBe(true);
  const rung = Math.round((await scroll()) / 64);
  await expect(ladder.getByRole("radio").nth(rung)).toHaveAttribute("aria-checked", "true");
});
