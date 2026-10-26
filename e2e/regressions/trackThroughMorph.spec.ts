// Cesium drops the track as a morph starts (SceneTransitioner clears the tracked object), so
// switching the projection while following a satellite lost it, and the url's `track` with it.
// The bookmarks journey lost the ISS this way when its track engaged before the morph began.

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { menuSwitch, openMenu } from "../support/ui";

const ISS = "ISS (ZARYA)";

test("a satellite tracked in 2D stays tracked through the morph to 3D and back", async ({ page }) => {
  await openApp(page, `tags=&sats=${encodeURIComponent(ISS)}&elements=Point,Label&track=${encodeURIComponent(ISS)}&scene=2D`);
  const tracked = () => page.evaluate(() => window.cc!.sats.trackedSatellite);
  await expect.poll(tracked, { message: "tracked in 2D" }).toBe(ISS);

  await openMenu(page, "Globe");
  for (const [projection, mode] of [
    ["3D", 3],
    ["2D", 2],
  ] as const) {
    await menuSwitch(page, projection).click();
    await expect.poll(() => page.evaluate(() => window.cc!.viewer.scene.mode), { message: `morphed to ${projection}` }).toBe(mode);
    await expect.poll(tracked, { message: `tracked in ${projection}` }).toBe(ISS);
    expect(new URL(page.url()).searchParams.get("track")).toBe(ISS);
  }
});
