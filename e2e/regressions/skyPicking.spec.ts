// Under the sky view a tap opened whatever the crosshair held, wherever it landed. It
// opens only the satellite it lands on, as on the globe, or the lock's card. Cesium's
// own handlers stay off: its double-click tracked what it hit, which then flew the
// camera back to where tracking began.

import type { Page } from "@playwright/test";

import { canvasBox, openApp, waitForSky, waitTicks } from "../support/app";
import { expect, test } from "../support/test";

test.use({ viewport: { width: 1280, height: 800 } });

const QUERY = "gs=48.1372,11.5756,Munich&scene=Sky&elements=Point";

/** A satellite drawn left of the crosshair, clear of the menu, the clock deck and the info panel, in canvas pixels. */
const satelliteOffCrosshair = (page: Page) =>
  page.evaluate(() => {
    const { viewer, sats } = window.cc!;
    const { clientWidth: width, clientHeight: height } = viewer.canvas;
    for (const sat of sats.activeSatellites) {
      const position = sat.defaultEntity?.position?.getValue(viewer.clock.currentTime);
      const at = position && viewer.scene.cartesianToCanvasCoordinates(position);
      if (at && at.x > 200 && at.y > 150 && at.x < width / 2 - 100 && at.y < height - 200) {
        return { x: at.x, y: at.y, name: sat.props.name };
      }
    }
    return undefined;
  });

test("a tap on empty sky opens nothing, though the crosshair holds a satellite; its card does", async ({ page }) => {
  await openApp(page, QUERY);
  await waitForSky(page);

  const locked = await page.evaluate(() => {
    const { skyInteraction, skyView } = window.cc!;
    const target = skyInteraction.targets.find((candidate) => candidate.elevation > 30);
    if (target) {
      skyView.look({ azimuth: target.azimuth, pitch: target.elevation, roll: 0 });
    }
    return target?.name;
  });
  expect(locked, "a satellite high enough to aim at").toBeDefined();
  const card = page.locator(".sky-hud__card");
  await expect(card.locator(".sky-hud__name")).toHaveText(locked!);

  // A spot no satellite is drawn near.
  const empty = await page.evaluate(() => {
    const { skyInteraction, viewer } = window.cc!;
    const { clientWidth: width, clientHeight: height } = viewer.canvas;
    for (let y = 200; y < height - 250; y += 20) {
      for (let x = 200; x < width - 200; x += 20) {
        if (
          Math.hypot(x - width / 2, y - height / 2) > 100 &&
          skyInteraction.targets.every((target) => !target.window || Math.hypot(target.window.x - x, target.window.y - y) > 40)
        ) {
          return { x, y };
        }
      }
    }
    return undefined;
  });
  expect(empty, "a patch of empty sky").toBeDefined();
  const box = await canvasBox(page);
  await page.mouse.click(box.x + empty!.x, box.y + empty!.y);
  await waitTicks(page, 5);
  await expect(page.locator(".entity-info-panel")).toBeHidden();
  expect(await page.evaluate(() => window.cc!.viewer.selectedEntity?.name)).toBeUndefined();

  await card.click();
  await expect(page.locator(".entity-info-panel .head__name")).toHaveText(locked!);
});

test("a click on a satellite opens it, and a double-click tracks nothing", async ({ page }) => {
  await openApp(page, QUERY);
  await waitForSky(page);

  const target = await satelliteOffCrosshair(page);
  expect(target, "a satellite away from the crosshair").toBeDefined();
  await page.evaluate(() => {
    const { viewer } = window.cc!;
    const tracked: string[] = [];
    (window as unknown as { tracked: string[] }).tracked = tracked;
    viewer.trackedEntityChanged.addEventListener(() => tracked.push(viewer.trackedEntity?.name ?? ""));
  });
  const box = await canvasBox(page);

  await page.mouse.click(box.x + target!.x, box.y + target!.y);
  await expect(page.locator(".entity-info-panel .head__name")).toHaveText(target!.name);
  await page.mouse.dblclick(box.x + target!.x, box.y + target!.y);
  await waitTicks(page, 5);

  expect(await page.evaluate(() => (window as unknown as { tracked: string[] }).tracked)).toEqual([]);
});

test.describe("by touch", () => {
  test.use({ hasTouch: true });

  test("a finger just off a satellite opens it, as in the iOS app", async ({ page }) => {
    await openApp(page, QUERY);
    await waitForSky(page);

    // One with no neighbour near enough to win the tap instead.
    const target = await page.evaluate(() => {
      const { viewer, sats } = window.cc!;
      const { clientWidth: width, clientHeight: height } = viewer.canvas;
      const drawn = sats.activeSatellites.flatMap((sat) => {
        const position = sat.defaultEntity?.position?.getValue(viewer.clock.currentTime);
        const at = position && viewer.scene.cartesianToCanvasCoordinates(position);
        return at ? [{ x: at.x, y: at.y, name: sat.props.name }] : [];
      });
      return drawn.find(
        (sat) =>
          sat.x > 200 &&
          sat.y > 150 &&
          sat.x < width / 2 - 100 &&
          sat.y < height - 200 &&
          drawn.every((other) => other === sat || Math.hypot(other.x - sat.x, other.y - sat.y) > 50),
      );
    });
    expect(target, "a lone satellite away from the crosshair").toBeDefined();
    const box = await canvasBox(page);

    await page.touchscreen.tap(box.x + target!.x + 12, box.y + target!.y + 10);
    await expect(page.locator(".entity-info-panel .head__name")).toHaveText(target!.name);
  });
});
