// The benchmark panel (ADR 0016) as a visitor uses it: a subset of the scenes ticked and run, a
// measured row opened for the rest of its figures, and a sweep run from its settings, with
// its tables and exports. The native app's panel offers the same. A run folds the menu off the
// scenes it measures.

import { openApp } from "../support/app";
import { expect, test } from "../support/test";
import { openMenu } from "../support/ui";

test("runs the scenes ticked and opens a measured row", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, "bench=true");
  const panel = page.locator(".bench");
  await expect(panel.getByRole("status")).toContainText(/^\d+ scenes · ≈ /);

  await panel.getByRole("checkbox", { name: "All scenes" }).uncheck();
  await expect(panel.getByRole("button", { name: "Run 0 scenes" })).toBeDisabled();
  await panel.getByRole("checkbox", { name: "Default view", exact: true }).check();
  await openMenu(page, "Graphics");
  await panel.getByRole("button", { name: "Run 1 scene" }).click();
  await expect(page.getByRole("region", { name: "Graphics" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");
  // Tabs lock while a run is going.
  await expect(panel.getByRole("tab", { name: "Sweep" })).toBeDisabled();
  await expect(panel.getByRole("status")).toHaveText("Done", { timeout: 60_000 });

  const row = panel.getByRole("row", { name: /Default view/ });
  await expect(row).toContainText(/\d+ satellites/);
  await row.click();
  // The performance panel's figures.
  await expect(panel.locator(".bench__details")).toContainText("over budget");
  await expect(panel.locator(".bench__details")).toContainText("total CPU");
  await expect(panel.locator(".bench__details")).toContainText("x_tick_ms");
  await expect(panel.getByRole("button", { name: "Copy report" })).toBeEnabled();
});

test("runs a sweep from its settings and fills its tables", async ({ page }) => {
  test.setTimeout(90_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page, "bench=true&elements=Point");
  const panel = page.locator(".bench");
  await panel.getByRole("tab", { name: "Sweep" }).click();
  await panel.getByRole("textbox", { name: "Counts" }).fill("0, 50");
  // Two counts and the first again at the end.
  await panel.getByRole("button", { name: "Run 3 steps" }).click();
  // Without a drift: the steps differ by under the millisecond it needs.
  await expect(panel.getByRole("status")).toHaveText(/^Done/, { timeout: 60_000 });

  const steps = panel.locator(".bench__section", { has: page.getByRole("heading", { name: "Steps", exact: true }) });
  await expect(steps.getByRole("row")).toHaveCount(4);
  await expect(panel.getByRole("heading", { name: /^Scaling/ })).toBeVisible();
  await expect(panel.getByRole("heading", { name: /^Drift/ })).toBeVisible();
  await panel.getByRole("button", { name: "Copy JSON" }).click();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as { rows: { sats: number; cpuTotalPct: number | ""; overBudgetPct: number | "" }[] };
  expect(copied.rows.map((row) => row.sats)).toEqual([0, 50, 0]);
  expect(copied.rows[1]?.cpuTotalPct).not.toBe("");
  expect(copied.rows[1]?.overBudgetPct).not.toBe("");
});

test("closing the panel mid-run stops the run, and the view it puts back keeps it closed", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page, "bench=true");
  const panel = page.locator(".bench");
  await panel.getByRole("checkbox", { name: "All scenes" }).uncheck();
  await panel.getByRole("checkbox", { name: "Default view", exact: true }).check();
  await panel.getByRole("button", { name: "Run 1 scene" }).click();
  await expect(panel.getByRole("status")).toHaveText(/^1 of 1 · /);
  await panel.getByRole("button", { name: "Close" }).click();

  // Read in the page: `running` is a getter, which serialising the runner would lose.
  const state = () =>
    page.evaluate(() => {
      const { runner, report } = (window as unknown as { bench: { runner: { running: boolean }; report?: Record<string, unknown> } }).bench;
      return { running: runner.running, cancelled: report?.benchmark_cancelled };
    });
  await expect.poll(state).toEqual({ running: false, cancelled: true });
  await expect(panel).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("bench")).toBeNull();
});
