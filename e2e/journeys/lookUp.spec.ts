// Stand at my ground station and look up: open the sky view from the station's
// panel, drag the sky until the crosshair holds a satellite, tap it, and go back to
// the globe. METEOSAT-12 is geostationary, so it holds still in Munich's sky.

import type { Page } from "@playwright/test";

import { openApp, waitForSky } from "../support/app";
import { expect, test } from "../support/test";
import { addStationHere, clickEntity, closeMenuPanel, menuSwitch, openMenu } from "../support/ui";

const MUNICH = { latitude: 48.1372, longitude: 11.5756 };
const TARGET = "METEOSAT-12 (MTG-I1)";

test.use({ geolocation: MUNICH, permissions: ["geolocation"], viewport: { width: 1280, height: 800 } });

/** The target's azimuth and elevation from the observer, against the geodetic normal. */
const skyPosition = (page: Page, name: string) =>
  page.evaluate((wanted) => {
    const { viewer, skyView, sats } = window.cc!;
    const sat = sats.activeSatellites.find((candidate) => candidate.props.name === wanted)!;
    const p = sat.defaultEntity!.position!.getValue(viewer.clock.currentTime)!;
    const [lat, lon] = [skyView.observer!.lat, skyView.observer!.lon].map((degrees) => (degrees * Math.PI) / 180) as [number, number];
    // WGS84 ellipsoid surface point under the observer; the eye height does not matter at GEO range.
    const a = 6378137;
    const e2 = 6.69437999014e-3;
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    const o = [n * Math.cos(lat) * Math.cos(lon), n * Math.cos(lat) * Math.sin(lon), n * (1 - e2) * Math.sin(lat)];
    const d = [p.x - o[0]!, p.y - o[1]!, p.z - o[2]!];
    const east = [-Math.sin(lon), Math.cos(lon), 0];
    const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
    const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const dot = (u: number[], v: number[]) => u.reduce((sum, value, index) => sum + value * v[index]!, 0);
    const range = Math.sqrt(dot(d, d));
    return {
      azimuth: ((Math.atan2(dot(d, east), dot(d, north)) * 180) / Math.PI + 360) % 360,
      elevation: (Math.asin(dot(d, up) / range) * 180) / Math.PI,
    };
  }, name);

test("from my station, look up and find a satellite in the sky", async ({ page }) => {
  await openApp(page, "", { live: true });
  await addStationHere(page, "Munich");
  await closeMenuPanel(page, "Ground station");

  // The station's pin on the globe opens its panel; the telescope stands there.
  await clickEntity(page, "Munich");
  const panel = page.locator(".entity-info-panel");
  await expect(panel.locator(".head__name")).toHaveText("Munich");
  await panel.getByRole("button", { name: "View the sky from this ground station" }).click();
  await waitForSky(page);
  await expect(page.locator(".sky-hud--settled")).toBeVisible();

  // Drag the sky so the target sits under the crosshair: the view follows the cursor.
  const target = await skyPosition(page, TARGET);
  const view = await page.evaluate(() => ({ ...window.cc!.skyView.aim, fovy: window.cc!.skyView.fovy }));
  const box = (await page.locator("#cesiumContainer canvas").boundingBox())!;
  const perPixel = view.fovy / box.height;
  const turn = ((view.azimuth - target.azimuth + 540) % 360) - 180;
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + turn / perPixel, cy + (target.elevation - view.pitch) / perPixel, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator(".sky-hud__card .sky-hud__name")).toHaveText(TARGET);
  // A tap anywhere opens what the crosshair holds.
  await page.mouse.click(cx, cy);
  await expect(panel.locator(".head__name")).toHaveText(TARGET);

  // Back to the globe from the View menu.
  await openMenu(page, "View");
  await menuSwitch(page, "3D").click();
  await expect(page.locator(".sky-hud")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.scene.mode)).toBe(3);
});
