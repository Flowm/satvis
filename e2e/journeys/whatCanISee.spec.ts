// The sky view dims what cannot be seen and hides it on request (docs/adr/0010-sky-visibility.md).
// At the fixture time it is noon in Munich; by 17:45 UTC the sun is about 9° down.

import type { Page } from "@playwright/test";

import { openApp, setClock, waitForSky, waitTicks } from "../support/app";
import { expect, test } from "../support/test";
import { menuSwitch, openMenu } from "../support/ui";

test.use({ viewport: { width: 1280, height: 800 } });

/** Each satellite in the sky: its verdict and how its point is drawn. */
const sky = (page: Page) =>
  page.evaluate(() =>
    window.cc!.skyInteraction.targets.map((target) => ({
      name: target.name,
      azimuth: target.azimuth,
      elevation: target.elevation,
      visibility: target.visibility,
      appearance: target.sat.skyAppearance,
    })),
  );

test("after dusk, the sky view tells what can be seen from what cannot", async ({ page }) => {
  await openApp(page, "gs=48.1372,11.5756,Munich&scene=Sky&elements=Point,Label");
  await waitForSky(page);

  const noon = await sky(page);
  expect(noon.length).toBeGreaterThan(0);
  expect(noon.every((target) => target.visibility === "daylight" && target.appearance === "muted")).toBe(true);

  await setClock(page, "2026-10-05T17:45:00Z");
  await waitTicks(page, 3);
  const dusk = await sky(page);
  const seen = dusk.filter((target) => target.elevation > 20 && target.visibility === "visible");
  expect(seen.length, "a lit satellite well above the horizon").toBeGreaterThan(0);
  // The weather group's geostationary satellites, 38,000 km away.
  expect(dusk.some((target) => target.visibility === "far")).toBe(true);
  expect(dusk.every((target) => target.appearance === (target.visibility === "visible" ? "normal" : "dimmed"))).toBe(true);

  // Aimed straight at it, the crosshair locks on and the card gives the verdict.
  const target = seen[0]!;
  await page.evaluate(({ azimuth, elevation }) => window.cc!.skyView.look({ azimuth, pitch: elevation, roll: 0 }), target);
  await expect(page.locator(".sky-hud__card .sky-hud__name")).toHaveText(target.name);
  await expect(page.locator(".sky-hud__facts")).toContainText("Could be seen");

  await openMenu(page, "Sky");
  await menuSwitch(page, "Show").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("unseen")).toBe("show");
  await waitTicks(page, 3);
  expect((await sky(page)).every((each) => each.appearance === "normal")).toBe(true);

  await menuSwitch(page, "Hide").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("unseen")).toBe("hide");
  await waitTicks(page, 3);
  const hidden = await sky(page);
  expect(hidden.every((each) => each.appearance === (each.visibility === "visible" ? "normal" : "hidden"))).toBe(true);
  expect(
    hidden.some((each) => each.appearance === "hidden"),
    "something in shadow to hide",
  ).toBe(true);

  // Leaving restores every satellite the sky view styled.
  await menuSwitch(page, "Look up").click();
  await expect(page.locator(".sky-hud")).toBeHidden();
  const restored = await page.evaluate(() => window.cc!.sats.activeSatellites.every((sat) => sat.skyAppearance === "normal"));
  expect(restored).toBe(true);
  // On the globe the choice is kept, but has nothing to act on.
  await expect(menuSwitch(page, "Hide").locator("input")).toBeDisabled();
});
