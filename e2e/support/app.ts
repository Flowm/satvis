// Opens the app on the GP fixture with every external host cut off, so a spec sees
// the same satellites at the same time on any machine.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, type Page } from "@playwright/test";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/gp/", import.meta.url));

/** Within a day of every fixture epoch (e2e/fixtures/gp). */
export const FIXTURE_TIME = "2026-10-05T12:00Z";

/** Serves `/api` from the fixture and aborts every request that leaves localhost. */
export async function useFixtureNetwork(page: Page): Promise<void> {
  await page.route(
    (url) => url.hostname !== "localhost",
    (route) => route.abort("blockedbyclient"),
  );
  await page.route("**/api/groups.json", (route) => route.fulfill({ contentType: "application/json", body: readFileSync(`${FIXTURE_DIR}groups.json`) }));
  await page.route("**/api/gp/*.json", (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    try {
      return route.fulfill({ contentType: "application/json", body: readFileSync(`${FIXTURE_DIR}${name}`) });
    } catch {
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
  });
}

/**
 * Opens `query` at the fixture time and waits until the satellites are built and
 * the globe tiles are loaded. Every console error fails the spec unless it matches
 * `allowErrors`.
 */
export async function openApp(page: Page, query: string, { allowErrors = [] as RegExp[] } = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !allowErrors.some((pattern) => pattern.test(message.text()))) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await useFixtureNetwork(page);
  const params = new URLSearchParams(query);
  if (!params.has("time")) {
    params.set("time", FIXTURE_TIME);
  }
  await page.goto(`/?${params.toString().replaceAll("%2C", ",")}`);
  await waitForScene(page);
  return errors;
}

/** Built satellites and loaded tiles. A frame must run for either to change. */
export async function waitForScene(page: Page): Promise<void> {
  await page.waitForFunction(() => window.cc !== undefined);
  await expect
    .poll(() => page.evaluate(() => window.cc!.sats.activeSatellites.length > 0 && !window.cc!.sats.building && window.cc!.viewer.scene.globe.tilesLoaded), {
      message: "satellites built and globe tiles loaded",
    })
    .toBe(true);
}

// The helpers below count clock ticks, not milliseconds: a GitHub runner's SwiftShader
// draws about 1 frame a second, a laptop's 5, a GPU 60. Every frame ticks the clock
// whether or not it renders.

/**
 * Returns once `quietTicks` ticks and `quietMs` in a row pass without a render, or
 * after `maxTicks` regardless. Both, because the frames that follow a change come
 * from geometry built in web workers, which finish on wall time, not per frame.
 */
export async function waitForQuiet(page: Page, options: { quietTicks: number; quietMs: number; maxTicks: number }): Promise<void> {
  await page.evaluate(
    ({ quietTicks, quietMs, maxTicks }) =>
      new Promise<void>((resolve) => {
        const { scene, clock } = window.cc!.viewer;
        let ticks = 0;
        let quiet = 0;
        let lastRender = performance.now();
        const offRender = scene.postRender.addEventListener(() => {
          quiet = 0;
          lastRender = performance.now();
        });
        const offTick = clock.onTick.addEventListener(() => {
          // onTick runs before the frame's render, so it judges the frame before.
          ticks += 1;
          if ((quiet >= quietTicks && performance.now() - lastRender >= quietMs) || ticks >= maxTicks) {
            offRender();
            offTick();
            resolve();
          }
          quiet += 1;
        });
      }),
    options,
  );
}

/**
 * Frames rendered over the next `ticks` clock ticks, and for each one what asked
 * for it: the callers of `requestRender` since the last render, or the camera or
 * clock when nothing called it.
 */
export async function rendersOverTicks(page: Page, ticks: number): Promise<{ renders: number; causes: string[] }> {
  return page.evaluate(
    (count) =>
      new Promise<{ renders: number; causes: string[] }>((resolve) => {
        const { scene, clock } = window.cc!.viewer;
        const start = performance.now();
        let renders = 0;
        let seen = 0;
        let requests: string[] = [];
        const causes: string[] = [];
        const requestRender = scene.requestRender;
        scene.requestRender = function (this: typeof scene) {
          const frames = new Error().stack!.split("\n").slice(2, 5);
          requests.push(
            frames
              .map((frame) =>
                frame
                  .trim()
                  .replace(/\(?https?:\/\/[^/]+/, "(")
                  .replace(/\?v=\w+/, ""),
              )
              .join(" < "),
          );
          requestRender.call(this);
        };
        const offRender = scene.postRender.addEventListener(() => {
          renders += 1;
          const at = `tick ${seen}, ${Math.round(performance.now() - start)} ms`;
          causes.push(requests.length > 0 ? `${at}: ${[...new Set(requests)].join(" | ")}` : `${at}: no requestRender (camera moved or time changed)`);
          requests = [];
        });
        const offTick = clock.onTick.addEventListener(() => {
          // Counted at the next tick, so the last frame's render is included.
          if (seen === count) {
            offRender();
            offTick();
            scene.requestRender = requestRender;
            resolve({ renders, causes });
          }
          seen += 1;
        });
      }),
    ticks,
  );
}
