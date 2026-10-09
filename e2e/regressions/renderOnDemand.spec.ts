// requestRenderMode (createViewer.ts) with every CallbackProperty user on: a paused
// clock must draw nothing. Not under `bench=true`, which turns the mode off.

import { openApp, rendersOverTicks, waitForOpenedLinkThumbnail, waitForQuiet } from "../support/app";
import { expect, test } from "../support/test";

const COMPONENTS = "Point,Label,Orbit,Orbit+track,Ground+track,Sensor+cone,Ground+station+link";

test("a paused clock draws no frames", async ({ page }) => {
  await openApp(page, `elements=${COMPONENTS}&gs=48.1371,11.5754`);
  expect(await page.evaluate(() => window.cc!.viewer.scene.requestRenderMode)).toBe(true);

  expect((await rendersOverTicks(page, 10)).renders).toBeGreaterThan(0);
  // Until the opened link is photographed, its capture asks for frames.
  await waitForOpenedLinkThumbnail(page);

  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));
  // The pause costs a few frames: the orbit batch rebuilds on the next tick, and its
  // geometry lands over the frames after.
  await waitForQuiet(page, { quietTicks: 5, quietMs: 1500, maxTicks: 60, maxMs: 10_000 });
  const paused = await rendersOverTicks(page, 10);
  expect(paused.renders, paused.causes.join("\n")).toBe(0);
});
