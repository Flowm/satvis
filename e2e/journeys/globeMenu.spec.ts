// The globe's right-click and long-press menu: a station added where the click fell, removed
// and the sky view entered from a new one.

import type { Page } from "@playwright/test";

import { BLOCKED_TERRAIN, canvasBox, openApp, waitForSky } from "../support/app";
import { expect, test } from "../support/test";
import { clickEntity, DEVICES, openMenu, touchscreen } from "../support/ui";

test.use({ allowConsoleErrors: BLOCKED_TERRAIN });

/** The url's ground stations, as `lat,lon[,name]` entries. */
const stations = (page: Page) => (new URL(page.url()).searchParams.get("gs") ?? "").split("_").filter(Boolean);

test.describe("desktop", () => {
  test.use(DEVICES.desktop);

  test("right-click the globe to add a station, its pin to remove it, and look up from a new one", async ({ page }) => {
    await openApp(page, "tags=", { satellites: false });
    const menu = page.getByRole("menu");
    // The default view frames the whole globe in the middle of the page.
    const { cx, cy } = await canvasBox(page);

    await page.mouse.click(cx, cy, { button: "right" });
    await expect(menu.getByText(/^-?\d+\.\d\d°, -?\d+\.\d\d°$/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    expect(stations(page)).toEqual([]);

    await page.mouse.click(cx, cy, { button: "right" });
    await menu.getByRole("menuitem", { name: "Add ground station here" }).click();
    await expect.poll(() => stations(page)).toHaveLength(1);
    await expect(menu).toBeHidden();

    // An unnamed station's pin is named by its coordinates.
    const pin = await page.evaluate(() => window.cc!.sats.groundStations[0]!.name);
    await clickEntity(page, pin, "right");
    await expect(menu.getByText(pin)).toBeVisible();
    await menu.getByRole("menuitem", { name: "Remove ground station" }).click();
    await expect.poll(() => stations(page)).toEqual([]);

    await page.mouse.click(cx, cy, { button: "right" });
    await menu.getByRole("menuitem", { name: "Look up from here" }).click();
    await waitForSky(page);
    expect(stations(page)).toHaveLength(1);
    // The sky view's ground is underfoot, so no menu opens there.
    await page.mouse.click(cx, cy, { button: "right" });
    await expect(menu).toBeHidden();
  });

  test("Control-click opens the menu over the open panel, and its Add ends Pick on globe", async ({ page }) => {
    await openApp(page, "tags=", { satellites: false });
    await openMenu(page, "Locations");
    await page.getByRole("button", { name: "Pick on globe" }).click();
    const menu = page.getByRole("menu");
    const { cx, cy } = await canvasBox(page);

    await page.keyboard.down("Control");
    await page.mouse.click(cx, cy);
    await page.keyboard.up("Control");
    await menu.getByRole("menuitem", { name: "Add ground station here" }).click();

    await expect(page.locator(".gsList__row")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Pick on globe" })).toBeVisible();
  });
});

test.describe("phone", () => {
  test.use(DEVICES.phone);

  test("a finger held on the globe opens the menu, and the open panel stays", async ({ page }) => {
    await openApp(page, "tags=", { satellites: false });
    await openMenu(page, "Locations");
    const rows = page.locator(".gsList__row");
    await expect(rows).toHaveCount(0);
    const menu = page.getByRole("menu");
    // Below the panel, on the globe the default view frames.
    const { cx, cy, height } = await canvasBox(page);
    const at: [number, number, number] = [0, cx, cy + height / 6];

    const touch = await touchscreen(page);
    await touch("touchStart", [at]);
    await expect(menu.getByRole("menuitem", { name: "Add ground station here" })).toBeVisible();
    await touch("touchEnd", [at]);
    await menu.getByRole("menuitem", { name: "Add ground station here" }).click();

    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toBeVisible();
    expect(stations(page)).toHaveLength(1);
  });

  test("a slow tap still places a station in Pick on globe", async ({ page }) => {
    await openApp(page, "tags=", { satellites: false });
    await openMenu(page, "Locations");
    await page.getByRole("button", { name: "Pick on globe" }).click();
    const { cx, cy, height } = await canvasBox(page);
    const at: [number, number, number] = [0, cx, cy + height / 6];

    // Past the menu's hold, short of Cesium's 1.5 s.
    const touch = await touchscreen(page);
    await touch("touchStart", [at]);
    await page.waitForTimeout(900);
    await touch("touchEnd", [at]);

    await expect(page.locator(".gsList__row")).toHaveCount(1);
    await expect(page.getByRole("menu")).toBeHidden();
  });
});
