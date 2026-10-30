// A visitor steps through the about page's featured bookmarks, in the app's About dialog and on
// the standalone page, and opens one; on another preset's route About leaves them out.

import type { Locator, Page } from "@playwright/test";

import { fixtureIndex, openApp } from "../support/app";
import { expect, test } from "../support/test";
import { DEVICES, openMenu } from "../support/ui";

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
  const dialog = page.getByRole("dialog", { name: "About Satvis" });
  // Scrolled while it still zooms in, the body lands elsewhere once the animation ends,
  // and a click's own scroll into view then moves the carousel off its picture.
  await dialog.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  return dialog;
}

/** Steps with the buttons and the arrow keys, checking which slide's picture shows: the dialog may clip the lines under it. */
async function stepThrough(carousel: Locator): Promise<void> {
  const slide = (name: string) => carousel.getByRole("link", { name: new RegExp(name) });
  const shown = (name: string) => expect(slide(name).getByRole("img")).toBeInViewport({ ratio: 0.9 });
  const prev = carousel.getByRole("button", { name: "Previous bookmark" });
  const next = carousel.getByRole("button", { name: "Next bookmark" });

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

// The featured ISS bookmark's street map asks for hosts the fixture network cuts off.
test.use({ allowConsoleErrors: /ERR_BLOCKED_BY_CLIENT/ });

for (const [device, options] of Object.entries(DEVICES)) {
  test.describe(device, () => {
    test.use(options);

    test("About shows the featured bookmarks in the app's dark panel, and opens one in place", async ({ page }) => {
      await openApp(page, "", { satellites: false });
      const dialog = await openAbout(page);
      const carousel = dialog.getByRole("region", { name: "Featured bookmarks" });
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

    test("the about page steps through the featured bookmarks and links to them", async ({ page }) => {
      await page.goto("/about");
      const carousel = page.getByRole("region", { name: "Featured bookmarks" });
      await stepThrough(carousel);
      await expect(carousel.getByRole("link", { name: /Sky over Lauterbrunnen/ })).toHaveAttribute("href", /^\/\?scene=Sky&gs=46\.5935,7\.9091,Lauterbrunnen&/);
    });
  });
}

test("with reduced motion a step jumps instead of scrolling", async ({ page }) => {
  await page.goto("/about");
  const track = page.locator(".featuredCarousel__track");
  await expect(track).toHaveCSS("scroll-behavior", "smooth");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(track).toHaveCSS("scroll-behavior", "auto");
});

// The carousel's bookmarks are the default preset's; another route features its own in the Bookmarks panel.
test("on another preset's route, About leaves the carousel out and Bookmarks features that preset's own", async ({ page }) => {
  const index = fixtureIndex();
  index.presets.ot = {
    defaults: { tags: "Science" },
    groups: [{ name: "science" }],
    featured: [{ name: "Science on a map", thumbnail: "showcase/globe-card.jpg", query: { scene: "2D" } }],
  };
  await openApp(page, "", {
    path: "/ot",
    setup: async (setupPage) => {
      await setupPage.route("**/api/groups.json", (route) => route.fulfill({ json: index }));
    },
  });

  const dialog = await openAbout(page);
  await expect(dialog.getByRole("heading", { name: "What it does" })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Featured bookmarks" })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "See it in action" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();

  await openMenu(page, "Bookmarks");
  const panel = page.getByRole("region", { name: "Bookmarks" });
  await expect(panel.getByRole("tab", { name: /Featured/ })).toHaveAttribute("aria-selected", "true");
  await expect(panel.locator(".bookmarkCard")).toHaveText([/Science on a map/]);
});

// A worker from before featured bookmarks serves none: the default route still shows the about
// page's carousel, whose slides then open as plain links, and Bookmarks has no Featured tab.
test("on the default route About keeps the carousel when the index features nothing", async ({ page }) => {
  const index = fixtureIndex();
  delete index.presets.default!.featured;
  await openApp(page, "", {
    setup: async (setupPage) => {
      await setupPage.route("**/api/groups.json", (route) => route.fulfill({ json: index }));
    },
  });

  const dialog = await openAbout(page);
  await expect(dialog.getByRole("region", { name: "Featured bookmarks" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  await openMenu(page, "Bookmarks");
  const panel = page.getByRole("region", { name: "Bookmarks" });
  await expect(panel.getByRole("tab", { name: /Featured/ })).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: /Recent/ })).toHaveAttribute("aria-selected", "true");
});
