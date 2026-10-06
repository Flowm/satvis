// What a visitor does with the app's own controls. Journeys go through these; on a
// phone the menu column starts collapsed and the clock deck folded.

import type { Page } from "@playwright/test";

/** Opens a menu entry's panel, opening the menu column first where it is collapsed. */
export async function openMenu(page: Page, entry: string): Promise<void> {
  const expand = page.getByRole("button", { name: "Open menu" });
  if (await expand.isVisible()) {
    await expand.click();
  }
  await page.getByRole("button", { name: entry, exact: true }).click();
}

/** Closes the menu panel titled `title` with its own close button. */
export const closeMenuPanel = (page: Page, title: string) => page.getByRole("region", { name: title }).getByRole("button", { name: "Close panel" }).click();

/** A labelled switch, radio or checkbox in a menu panel. */
export const menuSwitch = (page: Page, label: string) => page.locator("label.toolbarSwitch", { hasText: new RegExp(`^\\s*${label}\\s*$`) });

/** Opens the clock deck's controls where they start folded. */
export async function openClockDeck(page: Page): Promise<void> {
  const stamp = page.locator(".stamp");
  if ((await stamp.getAttribute("aria-expanded")) === "false") {
    await stamp.click();
  }
}

/** Adds a ground station at the browser's geolocation, as the Ground station panel's button does. */
export async function addStationHere(page: Page, name: string): Promise<void> {
  await openMenu(page, "Ground station");
  await page.getByRole("button", { name: "My location" }).click();
  const station = page.locator(".gsList__row").last();
  await station.getByLabel("Name").fill(name);
  await station.getByLabel("Name").press("Enter");
}

/** Clicks the canvas where the named entity is drawn. Ground stations and satellites alike. */
export async function clickEntity(page: Page, name: string): Promise<void> {
  const at = await page.evaluate((wanted) => {
    const { viewer } = window.cc!;
    const collections = [viewer.entities, ...Array.from({ length: viewer.dataSources.length }, (_, index) => viewer.dataSources.get(index).entities)];
    const entity = collections.flatMap((collection) => collection.values).find((candidate) => candidate.name === wanted);
    const position = entity?.position?.getValue(viewer.clock.currentTime);
    const window2d = position ? viewer.scene.cartesianToCanvasCoordinates(position) : undefined;
    const box = viewer.scene.canvas.getBoundingClientRect();
    return window2d ? { x: box.left + window2d.x, y: box.top + window2d.y } : undefined;
  }, name);
  if (!at) {
    throw new Error(`${name} is not drawn`);
  }
  await page.mouse.click(at.x, at.y);
}

/**
 * The two shapes of visitor a journey runs as. A phone has touch, which folds the
 * clock deck, and a width below 640 px, which collapses the menu column.
 */
export const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
} as const;
