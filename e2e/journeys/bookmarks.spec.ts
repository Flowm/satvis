// A visitor opens a link, goes back to the default view in one click, returns to the
// link from Recent, and saves it under names that outlive a reload (ADR 0011).

import { clockMs, FIXTURE_TIME, openApp, waitForScene } from "../support/app";
import { expect, test } from "../support/test";
import { openMenu } from "../support/ui";

test.use({ viewport: { width: 1280, height: 800 } });

const LINK = "tags=Science&scene=2D&time=2026-10-05T11:00Z";

test("back to the default view, back to the link, and keep it", async ({ page }) => {
  await openApp(page, LINK, { live: true });
  const panel = page.getByRole("region", { name: "Bookmarks" });
  const cards = panel.locator(".bookmarkCard");

  await openMenu(page, "Bookmarks");
  await panel.getByRole("tab", { name: /Recent/ }).click();
  const opened = cards.filter({ hasText: "Science satellites" });
  await expect(opened, "the link is recorded").toHaveCount(1);
  await expect(opened).toContainText("Flat map");
  await expect(opened).toContainText("5 Oct, 11:00 UTC");

  await panel.getByRole("button", { name: "Default view" }).click();
  await expect.poll(() => new URL(page.url()).search).toBe("");
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.scene.mode), { message: "the globe is back" }).toBe(3);
  // The link's pinned hour is gone with it: the clock is at the present again.
  expect(Math.abs((await clockMs(page)) - Date.parse(FIXTURE_TIME))).toBeLessThan(5 * 60_000);
  await expect(panel.getByRole("button", { name: "Default view" })).toBeDisabled();

  await opened.getByRole("button").first().click();
  await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ tags: "Science", scene: "2D", time: "2026-10-05T11:00Z" });
  await expect(opened).toHaveClass(/bookmarkCard--current/);

  await panel.getByRole("button", { name: "Save this view" }).click();
  await expect(panel.getByRole("tab", { name: /Saved/ })).toHaveAttribute("aria-selected", "true");
  const name = panel.getByLabel("Bookmark name");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Science satellites, flat map");
  await name.fill("Science at eleven");
  await name.press("Enter");
  await expect(cards.filter({ hasText: "Science at eleven" })).toHaveCount(1);

  // Saved from Recent, the name opens with the footer's button saving it, not a new bookmark.
  const save = panel.getByRole("button", { name: "Save this view" });
  await panel.getByRole("tab", { name: /Recent/ }).click();
  await opened.getByRole("button", { name: "Save Science satellites" }).click();
  await expect(name).toBeFocused();
  await expect(save).toBeHidden();
  await name.fill("Kept link");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: "Kept link" })).toHaveCount(1);
  await expect(save).toBeVisible();

  // A reload reopens the visitor's own scene, so it is not recorded as another link.
  await page.reload();
  await waitForScene(page);
  await openMenu(page, "Bookmarks");
  await expect(panel.getByRole("tab", { name: /Saved/ })).toHaveAttribute("aria-selected", "true");
  await expect(cards).toHaveCount(2);
  await panel.getByRole("tab", { name: /Recent/ }).click();
  await expect(cards).toHaveCount(0);
});
