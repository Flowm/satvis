// The default base map is NaturalEarth, however deep its imagery goes in this
// checkout: only the ceiling (`__IMAGERY_MAX_LEVEL__`) changes, never the
// selection. A design that switched to a fallback provider when imagery was
// missing overwrote the route preset's base map after hydration.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { openApp, waitForScene } from "./support/app";
import { expect, test } from "./support/test";

/** vite.config.ts: levels 0-2 are committed, `pnpm update-imagery` generates 3-5. */
const CEILING = existsSync(fileURLToPath(new URL("../data/imagery/NaturalEarthII/3/0/0.webp", import.meta.url))) ? 5 : 2;

test(`the default route shows NaturalEarth down to level ${CEILING} and no deeper`, async ({ page }) => {
  const levels = new Set<number>();
  page.on("request", (request) => {
    const level = /\/data\/imagery\/NaturalEarthII\/(\d+)\//.exec(request.url())?.[1];
    if (level !== undefined) {
      levels.add(Number(level));
    }
  });
  await openApp(page, "");

  expect(new URL(page.url()).searchParams.get("layers")).toBeNull();
  await page.getByRole("button", { name: "Map" }).click();
  await expect(page.locator('input[name="basemap"][value="NaturalEarth"]')).toBeChecked();
  expect(await page.evaluate(() => window.cc!.viewer.imageryLayers.get(0).imageryProvider.maximumLevel)).toBe(CEILING);

  // Down to a few hundred kilometres, well past continent scale.
  await page.evaluate(() => {
    const { camera } = window.cc!.viewer;
    camera.zoomIn(camera.positionCartographic.height - 300_000);
  });
  await waitForScene(page);
  expect(Math.max(...levels)).toBe(CEILING);
  expect(new URL(page.url()).searchParams.get("layers")).toBeNull();
});
