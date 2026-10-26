// A visitor steps through the about page's demos, in the app's About dialog and on the
// standalone page, and opens one.

import type { Locator, Page } from "@playwright/test";

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES } from "../support/ui";

/** The luminance of a computed colour, 0 for black and 1 for white, its alpha ignored. A canvas resolves Tailwind's `oklch()`. */
async function luminance(locator: Locator, property: "color" | "backgroundColor"): Promise<number> {
  const [r, g, b] = await locator.evaluate((element, name) => {
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    context.fillStyle = getComputedStyle(element)[name];
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data].map((channel) => channel / 255);
  }, property);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Opens About from its link to /about, opening the menu column first where About is folded into it. */
async function openAbout(page: Page): Promise<Locator> {
  const trigger = page.locator('a[href="/about"]').first();
  if (!(await trigger.isVisible())) {
    await page.getByRole("button", { name: "Open menu" }).click();
  }
  await trigger.click();
  return page.getByRole("dialog", { name: "About Satvis" });
}

/** Steps with the buttons and the arrow keys, checking which demo's picture shows: the dialog may clip the lines under it. */
async function stepThrough(carousel: Locator): Promise<void> {
  const slide = (name: string) => carousel.getByRole("link", { name: new RegExp(name) });
  const shown = (name: string) => expect(slide(name).getByRole("img")).toBeInViewport({ ratio: 0.9 });
  const prev = carousel.getByRole("button", { name: "Previous demo" });
  const next = carousel.getByRole("button", { name: "Next demo" });

  await carousel.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await shown("Weather satellites");
  await expect(prev).toBeDisabled();
  await next.click();
  await shown("Follow the ISS");
  await expect(prev).toBeEnabled();

  await slide("Follow the ISS").focus();
  await carousel.press("ArrowRight");
  await shown("Sky over Lauterbrunnen");
  await expect(next).toBeDisabled();
  await carousel.press("ArrowLeft");
  await shown("Follow the ISS");
}

// The ISS demo's street map asks for hosts the fixture network cuts off.
test.use({ allowConsoleErrors: /ERR_BLOCKED_BY_CLIENT/ });

for (const [device, options] of Object.entries(DEVICES)) {
  test.describe(device, () => {
    test.use(options);

    test("About shows the demos in the app's dark panel, and opens one in place", async ({ page }) => {
      await openApp(page, "", { satellites: false });
      const dialog = await openAbout(page);
      const carousel = dialog.getByRole("region", { name: "Demos" });
      await expect(carousel).toBeVisible();

      // Inside #app, which carries `dark`: light ink on the dark panel, a dark backdrop.
      expect(await luminance(dialog.getByRole("heading", { name: "About Satvis" }), "color")).toBeGreaterThan(0.7);
      expect(await luminance(dialog.getByRole("button", { name: "Close" }), "color")).toBeGreaterThan(0.7);
      expect(await luminance(page.locator("[data-slot=overlay]"), "backgroundColor")).toBeLessThan(0.3);

      await stepThrough(carousel);
      await carousel.getByRole("link", { name: /Follow the ISS/ }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ sats: "ISS (ZARYA)", track: "ISS (ZARYA)" });
    });

    test("the about page steps through the demos and links to them", async ({ page }) => {
      await page.goto("/about");
      const carousel = page.getByRole("region", { name: "Demos" });
      await stepThrough(carousel);
      await expect(carousel.getByRole("link", { name: /Sky over Lauterbrunnen/ })).toHaveAttribute("href", /^\/\?scene=Sky&gs=46\.5935,7\.9091,Lauterbrunnen&/);
    });
  });
}

test("with reduced motion a step jumps instead of scrolling", async ({ page }) => {
  await page.goto("/about");
  const track = page.locator(".demoCarousel__track");
  await expect(track).toHaveCSS("scroll-behavior", "smooth");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(track).toHaveCSS("scroll-behavior", "auto");
});
