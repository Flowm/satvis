// Under the sky view a tap acts on what the crosshair holds (docs/adr/0003-sky-view.md),
// but Cesium's own handlers still selected what a click hit and tracked what a
// double-click hit, which then flew the camera back to where tracking began.

import { canvasBox, openApp, waitForSky, waitTicks } from "../support/app";
import { expect, test } from "../support/test";

test.use({ viewport: { width: 1280, height: 800 } });

test("a click off the crosshair selects nothing, and a double-click tracks nothing", async ({ page }) => {
  await openApp(page, "gs=48.1372,11.5756,Munich&scene=Sky&elements=Point");
  await waitForSky(page);

  // A satellite on screen, well clear of the crosshair at the centre.
  const target = await page.evaluate(() => {
    const { viewer, sats } = window.cc!;
    const { clientWidth: width, clientHeight: height } = viewer.canvas;
    for (const sat of sats.activeSatellites) {
      const position = sat.defaultEntity?.position?.getValue(viewer.clock.currentTime);
      const at = position && viewer.scene.cartesianToCanvasCoordinates(position);
      if (at && at.x > 50 && at.y > 50 && at.x < width - 50 && at.y < height - 50 && Math.hypot(at.x - width / 2, at.y - height / 2) > 150) {
        return { x: at.x, y: at.y };
      }
    }
    return undefined;
  });
  expect(target, "a satellite away from the crosshair").toBeDefined();
  await page.evaluate(() => {
    const { viewer } = window.cc!;
    const tracked: string[] = [];
    (window as unknown as { tracked: string[] }).tracked = tracked;
    viewer.trackedEntityChanged.addEventListener(() => tracked.push(viewer.trackedEntity?.name ?? ""));
  });
  const box = await canvasBox(page);

  await page.mouse.click(box.x + target!.x, box.y + target!.y);
  await page.mouse.dblclick(box.x + target!.x, box.y + target!.y);
  await waitTicks(page, 5);

  expect(await page.evaluate(() => window.cc!.viewer.selectedEntity?.name)).toBeUndefined();
  expect(await page.evaluate(() => (window as unknown as { tracked: string[] }).tracked)).toEqual([]);
});
