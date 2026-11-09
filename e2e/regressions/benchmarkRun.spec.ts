// A link starts a benchmark run of the preset's scenes (ADR 0016) without spreading: the url
// reads `bench=true` as the run starts, Recent keeps no run, and the run sends nothing. A
// scene's `track` link, as every link, opens no info panel, so no scene measures one.

import { BLOCKED_TERRAIN, openApp } from "../support/app";
import { expect, test } from "../support/test";

const ISS = "ISS (ZARYA)";

test("a bench=run link runs the scenes it names, then reads as the open panel", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, "bench=run&benchscenes=default_view");
  await expect.poll(() => new URL(page.url()).searchParams.get("bench")).toBe("true");
  expect(new URL(page.url()).searchParams.get("benchscenes")).toBeNull();

  const panel = page.locator(".bench");
  await expect(panel.getByRole("status")).toHaveText("Done", { timeout: 60_000 });
  const report = await page.evaluate(() => (window as unknown as { bench: { report: Record<string, unknown> } }).bench.report);
  expect(report).toMatchObject({ benchmark_version: 8, benchmark_platform: "web", benchmark_scenes: ["default_view"] });
  expect(report.scene_default_view_frames).toBeGreaterThan(20);
  expect(report.scene_default_view_cpu_ms).toBeGreaterThan(0);
  // Unpaced: every frame drawn, so the frame rate is a frame rate.
  expect(report.scene_default_view_fps).toBeGreaterThan(20);
  // Unpaced is never idle; the GPU's capped share is known wherever its timer is.
  expect(report.scene_default_view_idle).toBe(false);
  expect(report).toHaveProperty("scene_default_view_x_gpu_capped_pct");
  await expect(panel.getByRole("row", { name: /Default view/ })).toContainText(/\d+[.,]\d/);
  await expect(panel.getByRole("button", { name: "Send results" })).toBeDisabled();

  // The view the run found, back as it was, and pacing with it.
  expect(new URL(page.url()).searchParams.get("bench")).toBe("true");
  expect(await page.evaluate(() => window.cc!.viewer.scene.requestRenderMode)).toBe(true);
  const opened = await page.evaluate(() => localStorage.getItem("satvis:bookmarks:opened") ?? "");
  expect(opened).not.toContain('"run"');
});

// Unknown ids planned nothing, and the run read "Done" with nothing measured.
test.describe("naming no served scene", () => {
  test.use({ allowConsoleErrors: /No scene matches/ });
  test("a bench=run link fails instead of finishing", async ({ page }) => {
    await openApp(page, "bench=run&benchscenes=no_such_scene");
    await expect(page.locator(".bench").getByRole("status")).toHaveText(/Failed.*no_such_scene/);
    expect(await page.evaluate(() => (window as unknown as { bench: { report?: unknown } }).bench.report)).toBeUndefined();
  });
});

// The sky view's satellites are all drawn before its flight lands, so the scene completes
// without a change of count; the wait timed out at 90 s on that until the steady timer
// started then too.
test.describe("in the sky view", () => {
  // The scene asks for ReEarth terrain, which the tests block.
  test.use({ allowConsoleErrors: BLOCKED_TERRAIN });

  test("a sky view scene loads once its flight lands, not at the timeout", async ({ page }) => {
    test.setTimeout(90_000);
    await openApp(page, "bench=run&benchscenes=sky_view");
    await expect(page.locator(".bench").getByRole("status")).toHaveText("Done", { timeout: 60_000 });
    const report = await page.evaluate(() => (window as unknown as { bench: { report: Record<string, unknown> } }).bench.report);
    expect(report.scene_sky_view_timed_out).toBe(false);
    expect(report.scene_sky_view_load_s).toBeLessThan(30);
  });
});

test("a track link follows its satellite and opens no info panel", async ({ page }) => {
  await openApp(page, `tags=&sats=${encodeURIComponent(ISS)}&elements=Point,Label&track=${encodeURIComponent(ISS)}`);
  await expect.poll(() => page.evaluate(() => window.cc!.viewer.trackedEntity?.name ?? null)).toBe(ISS);
  expect(await page.evaluate(() => window.cc!.viewer.selectedEntity?.name ?? null)).toBeNull();
});
