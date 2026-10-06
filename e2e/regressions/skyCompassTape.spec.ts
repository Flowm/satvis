// The compass tape is a heading readout, so tilting the view must not stretch it.
// Projected onto the horizon, 15° of azimuth grew from 147 px at eye level to
// 1691 px at 85° pitch. `headingOffset` is unit-tested; this checks the live tape.

import type { Page } from "@playwright/test";

import { openApp, waitForSky } from "../support/app";
import { expect, test } from "../support/test";

/** The compass ticks' x and the elevation ticks' y, which follow the pitch. */
const tapes = (page: Page) =>
  page.evaluate(() => ({
    compass: [...document.querySelectorAll(".sky-hud__svg:not(.sky-hud__side) .sky-hud__tape > g > line")].map((line) => Number(line.getAttribute("x1"))),
    elevation: [...document.querySelectorAll(".sky-hud__side .sky-hud__tape > g > line")].map((line) => line.getAttribute("y1")).join(" "),
  }));

test("the compass tape keeps its tick spacing at every pitch", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "scene=Sky&gs=48.1400,11.5800");
  await waitForSky(page);

  const byPitch = new Map<number, number[]>();
  let elevation = (await tapes(page)).elevation;
  for (const pitch of [0, 30, 60, 85]) {
    await page.evaluate((value) => window.cc!.skyView.look({ pitch: value }), pitch);
    // The HUD refreshes on the next frame; the elevation tape shows when it has.
    await expect.poll(async () => (await tapes(page)).elevation).not.toBe(elevation);
    const current = await tapes(page);
    elevation = current.elevation;
    byPitch.set(pitch, current.compass);
  }

  const level = byPitch.get(0)!;
  expect(level.length).toBeGreaterThanOrEqual(3);
  for (const [pitch, ticks] of byPitch) {
    expect(ticks.length, `ticks at ${pitch}°`).toBe(level.length);
    ticks.forEach((x, index) => expect(Math.abs(x - level[index]!), `tick ${index} at ${pitch}°`).toBeLessThan(0.5));
  }
});
