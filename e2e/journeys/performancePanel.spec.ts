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
  await expect(panel.locator(".perf__fps")).toHaveText(/^\d+$/);
  await expect(panel).toContainText("paced");
  await expect(panel.locator(".perf__value").first()).toHaveText(/^\d+\.\d$/);
  expect(await page.evaluate(() => window.cc!.viewer.scene.requestRenderMode)).toBe(true);

  await panel.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("fps")).toBe("graph");
  await expect(panel.locator("canvas")).toBeVisible();
  // The same figures paced as unpaced: work against the budget, and every thread's CPU.
  // Idle, as here once the globe settles, over budget counts the CPU alone.
  await expect(panel).toContainText("frames by share of budget");
  await expect(panel.locator(".perf__foot")).toHaveText(/over(?: budget|, CPU)\s*(?:\d+|< 1) %\s*total CPU\s*(≥ )?\d+ %/);

  await panel.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("fps")).toBe("true");
  await expect(panel.locator("canvas")).toHaveCount(0);
});

test("a link opens the graph", async ({ page }) => {
  await openApp(page, "fps=graph");
  await expect(page.getByRole("button", { name: "Performance" }).locator("canvas")).toBeVisible();
});

// Under them, it covered the corner's second button, Stop tracking while a satellite is tracked.
test("the panels stand beside the corner's buttons", async ({ page }) => {
  await openApp(page, "fps=graph&bench=true");
  const column = await page.locator(".measurement").boundingBox();
  const corner = await page.locator("#toolbarRight").boundingBox();
  expect(column!.x + column!.width).toBeLessThanOrEqual(corner!.x);
});
