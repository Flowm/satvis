// A camera inside a tracked model's bounding sphere: Cesium measured no distance to it,
// so the model's pixel diameter came out infinite, the label's pixel offset with it, and
// its billboard collection's bounding radius NaN. Rendering stopped in the frustum split.

import { openApp, waitTicks } from "../support/app";
import { expect, test } from "../support/test";

const ISS = "ISS (ZARYA)";

test("a camera inside the tracked model's bounding sphere keeps rendering", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openApp(page, `tags=&sats=${encodeURIComponent(ISS)}&elements=Point,Label,3D model&track=${encodeURIComponent(ISS)}`);
  await expect
    .poll(() => page.evaluate((name) => window.cc!.sats.activeSatellites.find((sat) => sat.props.name === name)?.model.state(), ISS), { message: "model loaded" })
    .toBe("ready");

  await page.evaluate((name) => {
    const { viewer, sats } = window.cc!;
    const radius = sats.activeSatellites.find((sat) => sat.props.name === name)!.model.radius();
    // The tracked camera's position is in the satellite's frame: scaling it moves along the line of sight.
    const { position } = viewer.camera;
    const distance = Math.hypot(position.x, position.y, position.z);
    const factor = (radius * 0.5) / distance;
    position.x *= factor;
    position.y *= factor;
    position.z *= factor;
    viewer.scene.requestRender();
  }, ISS);
  await waitTicks(page, 10);

  // Cesium stops its render loop after a render error, so no frame follows a request.
  const rendered = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const { scene } = window.cc!.viewer;
        const remove = scene.postRender.addEventListener(() => {
          remove();
          resolve(true);
        });
        scene.requestRender();
        setTimeout(() => resolve(false), 5000);
      }),
  );
  expect(rendered).toBe(true);
});
