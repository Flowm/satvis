// The performance panel (ADR 0016) replaces Cesium's frame counter, measures without turning
// render pacing off, and expands into its frame-time graph, which the url keeps as `fps=graph`.

import { openApp } from "../support/app";
import { expect, test } from "../support/test";

test("the panel reads the frames, paced, and its graph rides the url", async ({ page }) => {
  await openApp(page, "fps=true");
  const panel = page.getByRole("button", { name: "Performance" });
  await expect(panel).toBeVisible();
  await expect(page.locator(".cesium-performanceDisplay")).toHaveCount(0);
  // Render on demand stays on: the panel reads the paced frames, not a frame rate of its own.
  await expect(panel).toContainText(/\d+ fps · paced/);
  await expect(panel).toContainText(/CPU \d/);
  expect(await page.evaluate(() => window.cc!.viewer.scene.requestRenderMode)).toBe(true);

  await panel.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("fps")).toBe("graph");
  await expect(panel.locator("canvas")).toBeVisible();
  // The same figures paced as unpaced: work against the budget, and every thread's CPU.
  await expect(panel).toContainText(/ms budget/);
  await expect(panel).toContainText(/p95 CPU \d/);
  await expect(panel).toContainText(/over budget \d+ % · total CPU (≥ )?\d+ %/);

  await panel.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("fps")).toBe("true");
  await expect(panel.locator("canvas")).toHaveCount(0);
});

test("a link opens the graph", async ({ page }) => {
  await openApp(page, "fps=graph");
  await expect(page.getByRole("button", { name: "Performance" }).locator("canvas")).toBeVisible();
});
