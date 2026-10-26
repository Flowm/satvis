// requestRenderMode (createViewer.ts) with every CallbackProperty user on: a paused
// clock must draw nothing. Not under `bench=true`, which turns the mode off.

import { openApp, rendersOverTicks, waitForOpenedLinkThumbnail, waitForQuiet, waitTicks } from "../support/app";
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

// renderPacing.ts: with the clock running, the time between renders follows how fast
// anything drawn can cross the screen.
test("a running clock renders a few frames a second at the default view, and every 1/30 s next to a satellite", async ({ page }) => {
  await openApp(page, "");
  await waitForOpenedLinkThumbnail(page);
  const interval = () => page.evaluate(() => window.cc!.viewer.scene.maximumRenderTimeChange);

  // From afar a LEO satellite crosses well under a pixel a second.
  await expect.poll(interval, { message: "paced at the default view" }).toBeGreaterThan(0.2);
  expect((await rendersOverTicks(page, 180)).renders, "the ceiling still draws").toBeGreaterThan(0);

  await page.evaluate(() => {
    const { viewer, sats } = window.cc!;
    const time = viewer.clock.currentTime;
    const position = sats.activeSatellites.map((sat) => sat.props.trajectory.entityPosition?.getValue(time)).find((p) => p !== undefined)!;
    // 20 km further out than the satellite, looking down past it.
    const scale = 1 + 20_000 / Math.hypot(position.x, position.y, position.z);
    const destination = position.clone();
    destination.x *= scale;
    destination.y *= scale;
    destination.z *= scale;
    viewer.camera.setView({ destination, orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
  });
  // For 50 ms after the camera moves the pacer holds 1/30 s whatever the bound; wait out
  // that and a recompute, so the floor read here is the bound's.
  await waitTicks(page, 40);
  for (let read = 0; read < 3; read += 1) {
    expect(await interval(), "the floor next to a satellite").toBeCloseTo(1 / 30);
    await waitTicks(page, 20);
  }
});

// The ribbon lies on the ground under the orbit, so from above the orbits it is paced as they are.
test("a running clock with a ground track is paced at the default view", async ({ page }) => {
  await openApp(page, "elements=Point,Label,Ground+track");
  await waitForOpenedLinkThumbnail(page);
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.scene.maximumRenderTimeChange), { message: "paced, not the 1/30 s floor" }).toBeGreaterThan(0.1);
});
