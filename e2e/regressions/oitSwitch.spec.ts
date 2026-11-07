// Turning order-independent translucency on threw in `Scene.render` and stopped
// rendering: Cesium derives a command's OIT copy only while the command is dirty. With HDR
// and log depth both on it re-derives every command every frame, which hid the bug; with
// HDR off, a static translucent primitive under a paused clock stays clean.

import { openApp, waitTicks } from "../support/app";
import { expect, test } from "../support/test";

const TRANSLUCENT_PASS = 10;

test("order-independent translucency turns on over translucent geometry drawn without it", async ({ page }) => {
  await openApp(page, "");
  expect(await page.evaluate(() => window.cc!.orderIndependentTranslucency)).toBe(false);
  await page.evaluate(() => {
    const { viewer } = window.cc!;
    viewer.scene.highDynamicRange = false;
    viewer.clock.shouldAnimate = false;
    // Constructors from the page, which exposes no Cesium module.
    const Color = viewer.scene.backgroundColor.constructor as new (r: number, g: number, b: number, a: number) => unknown;
    const Cartesian3 = viewer.camera.position.constructor as { fromDegrees(lon: number, lat: number): unknown; new (x: number, y: number, z: number): unknown };
    viewer.entities.add({
      position: Cartesian3.fromDegrees(11, 48) as never,
      ellipsoid: { radii: new Cartesian3(2e6, 2e6, 2e6) as never, material: new Color(1, 0, 0, 0.5) as never },
    });
  });
  // Its geometry builds in a worker.
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.cc!.viewer.scene.requestRender());
        await waitTicks(page, 2);
        return page.evaluate((pass) => {
          const { frustumCommandsList } = (window.cc!.viewer.scene as unknown as { _view: { frustumCommandsList: { commands: { owner?: object }[][]; indices: number[] }[] } })
            ._view;
          return frustumCommandsList.some((frustum) =>
            frustum.commands[pass]!.slice(0, frustum.indices[pass]).some((command) => command.owner?.constructor.name.startsWith("Primitive")),
          );
        }, TRANSLUCENT_PASS);
      },
      { message: "the ellipsoid drawn" },
    )
    .toBe(true);

  await page.evaluate(() => {
    window.cc!.orderIndependentTranslucency = true;
  });
  await waitTicks(page, 3);
  expect(await page.evaluate(() => window.cc!.renderLoop.running), "render loop running").toBe(true);
});
