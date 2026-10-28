// A morph asked for mid-morph left the orbits drawn as per-entity paths back in 3D
// (342 ms a frame vs 1.24 ms batched). Cesium completes the running morph first, which
// released the batched components while still in 2D, and the second morph found
// nothing left to suppress, so nothing re-created them as batched lines.

import { openApp, steady } from "../support/app";
import { expect, test } from "../support/test";
import { menuSwitch, openMenu } from "../support/ui";

const SATELLITES = ["ISS (ZARYA)", "NOAA 20 (JPSS-1)"];

test("orbits return to their batches after a morph back to 3D asked for mid-morph", async ({ page }) => {
  await openApp(page, `tags=&sats=${SATELLITES.map(encodeURIComponent).join(",")}&elements=Point,Orbit,Orbit track`);
  const mode = () => page.evaluate(() => window.cc!.viewer.scene.mode);

  await openMenu(page, "Globe");
  await menuSwitch(page, "2D").click();
  await expect.poll(mode, { message: "morphing to 2D" }).toBe(0);
  await menuSwitch(page, "3D").click();
  await expect.poll(mode, { message: "morphed back to 3D" }).toBe(3);

  const drawn = await steady(page, () =>
    page.evaluate(() =>
      window
        .cc!.sats.activeSatellites.flatMap((sat) => ["Orbit", "Orbit track"].map((name) => sat.components[name]))
        .map((component) => (component === undefined ? "missing" : "path" in component && component.path !== undefined ? "path" : "batched")),
    ),
  );
  expect(drawn).toEqual(Array(SATELLITES.length * 2).fill("batched"));
});
