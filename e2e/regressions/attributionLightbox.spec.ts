// Below 576 px Cesium's credit lightbox is full screen (main.css, .cesium-credit-lightbox-mobile).

import { openApp } from "../support/app";
import { expect, test } from "../support/test";

const overlay = ".cesium-credit-lightbox-overlay";

test("on a phone the lightbox covers the app chrome and its close button closes it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, "");
  await page.getByText("Attribution", { exact: true }).click();
  await expect(page.locator(overlay)).toBeVisible();
  await expect(page.locator(".cesium-credit-lightbox")).toHaveClass(/cesium-credit-lightbox-mobile/);

  const hits = await page.evaluate((overlaySelector) => {
    const target = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { inLightbox: Boolean(hit?.closest(overlaySelector)), isClose: Boolean(hit?.closest(".cesium-credit-lightbox-close")) };
    };
    return { menu: target("#toolbarLeft .menuColumn__toggle"), deck: target(".cluster"), close: target(".cesium-credit-lightbox-close") };
  }, overlay);
  expect(hits.menu.inLightbox, "the menu toggle is covered").toBe(true);
  expect(hits.deck.inLightbox, "the clock deck is covered").toBe(true);
  expect(hits.close.isClose, "the close button is reachable").toBe(true);

  await page.locator(".cesium-credit-lightbox-close").click();
  await expect(page.locator(overlay)).toBeHidden();
});

test("on a desktop the lightbox covers the toolbars and a click outside closes it", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openApp(page, "");
  await page.getByText("Attribution", { exact: true }).click();
  await expect(page.locator(overlay)).toBeVisible();
  await expect(page.locator(".cesium-credit-lightbox")).toHaveClass(/cesium-credit-lightbox-expanded/);
  const menuCovered = await page.evaluate((overlaySelector) => {
    const box = document.querySelector("#toolbarLeft .menuColumn__toggle")!.getBoundingClientRect();
    return Boolean(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(overlaySelector));
  }, overlay);
  expect(menuCovered, "the menu toggle is covered").toBe(true);

  await page.mouse.click(10, 300);
  await expect(page.locator(overlay)).toBeHidden();
});
