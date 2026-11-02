// Retakes the featured bookmarks' pictures (docs/adr/0011-bookmarks.md), every preset's in
// the core config and the plugins': each opened at its `pictureAt` with the clock stopped, in
// Chromium on the GPU and the real network, and read from the globe's canvas alone, so no
// panel or instrument is in it. Each gets one picture, 1600×1000 WebP, which its card and the
// about page's carousel both show. `pnpm update-showcase [name…]` retakes only those named.
//
// The app runs on Vite's dev server, which proxies /api to satvis.space, or to
// SATVIS_API_PROXY: a plugin's preset that is not deployed needs its local worker. proxy.mjs
// stands in between and serves the element sets pinned in pinned.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { parse } from "yaml";

import { PROXY_URL, startProxy } from "./proxy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const customDir = path.join(repoRoot, "data", "custom");

/** Drawn at twice the size it is written at, so its edges are smoothed by the scaling. */
const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 2;
/**
 * The widest it is shown: the about page's carousel, at most 43.5rem across, is 1392 pixels at
 * 2x and about 1200 on a phone at 3x, as is the iOS app's. A 480-pixel copy for the cards saved
 * 135 kB of the core's three, precached, for a second file per bookmark.
 */
const PICTURE = { width: 1600, height: 1000 };
/**
 * Past this, a low orbit that is not pinned is drawn away from where it was: it is placed from
 * today's element sets. Measured: 26 days out, the ISS was over desert where the App Store
 * screenshot, taken from element sets of its own week, has the Tyrrhenian Sea.
 */
const DRIFT_DAYS = 7;
/** Measured on the core's three: 46–71 kB a picture. JPEG at the same quality was 1.4 to 2.4 times that. */
const QUALITY = 0.8;
/**
 * What a checkout lacks until it is generated or fetched (README), by a file it holds: the
 * globe's base map past level 2, the star maps, and the 3D models, without which a tracked
 * satellite is a point and the camera stays back.
 */
const GENERATED = [
  ["data/imagery/NaturalEarthII/5", ".webp", "pnpm update-imagery"],
  ["data/starmap", ".webp", "pnpm update-starmap"],
  ["data/models/public", ".glb", "git submodule update --init"],
];

/** Whether `dir` holds a file ending in `extension`, not just its .gitignore. */
const holds = (dir, extension) => fs.existsSync(dir) && fs.readdirSync(dir, { recursive: true }).some((file) => String(file).endsWith(extension));

/** Each config file with what its pictures are written beside. */
function configs() {
  const plugins = fs.existsSync(customDir)
    ? fs
        .readdirSync(customDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(customDir, entry.name, "satvis.yaml")))
        .map((entry) => ({ file: path.join(customDir, entry.name, "satvis.yaml"), plugin: entry.name }))
    : [];
  return [{ file: path.join(repoRoot, "worker/src/config/satvis.core.yaml") }, ...plugins];
}

/**
 * Where a featured bookmark's picture goes. The core's are the site's own; a plugin's go to its
 * `showcase/`, which its sync.sh copies to `data/showcase/`, where its `thumbnail` points.
 */
function output(bookmark, plugin) {
  const where = plugin ? `data/custom/${plugin}` : "the core config";
  const match = (plugin ? /^data\/showcase\/([\w.-]+\.webp)$/ : /^showcase\/([\w.-]+\.webp)$/).exec(bookmark.thumbnail);
  if (!match) {
    throw new Error(`${where}, ${JSON.stringify(bookmark.name)}: a thumbnail there is ${plugin ? "data/showcase" : "showcase"}/<name>.webp`);
  }
  return path.join(plugin ? path.join(customDir, plugin, "showcase") : path.join(repoRoot, "public/showcase"), match[1]);
}

/**
 * Every featured bookmark with a `pictureAt`, as a link, where its picture goes (`file`) and the
 * star map it is drawn with (`stars`).
 */
function featuredBookmarks(only) {
  const found = [];
  for (const { file, plugin } of configs()) {
    for (const preset of parse(fs.readFileSync(file, "utf8"))?.presets ?? []) {
      for (const bookmark of preset.featured ?? []) {
        if (only.length > 0 && !only.includes(bookmark.name)) {
          continue;
        }
        if (bookmark.pictureAt === undefined) {
          console.warn(`Skipped ${JSON.stringify(bookmark.name)}: it has no pictureAt`);
          continue;
        }
        found.push({ ...bookmark, preset: preset.name, file: output(bookmark, plugin), stars: bookmark.query?.stars ?? preset.defaults?.stars });
      }
    }
  }
  return found;
}

/** The link a picture is taken of: the bookmark's, pinned to its minute, which the clock is then set to the second of. */
function pictureUrl(base, { preset, query = {}, pictureAt }) {
  const minute = new Date(pictureAt).toISOString().slice(0, 16) + "Z";
  const search = new URLSearchParams({ ...query, time: minute }).toString().replaceAll("%2C", ",");
  return new URL(`${preset === "default" ? "/" : `/${preset}`}?${search}`, base).href;
}

/**
 * The picture as a data url, read in the page from the app's own modules (Vite serves them by
 * path), or why there is none.
 */
async function picture(page, bookmark) {
  await page.waitForFunction(() => window.cc !== undefined, undefined, { timeout: 60_000 });
  return page.evaluate(
    async ({ at, stars, size, quality }) => {
      const { BACKDROP, readNextFrame, sceneSettled } = await import("/src/modules/util/thumbnail.ts");
      const { starMapSources } = await import("/src/config/starMaps.ts");
      const cc = window.cc;
      const scene = cc.viewer.scene;
      // A generated star map lands as images some seconds after the globe, Cesium's own as urls.
      const ownStars = stars === undefined || starMapSources(stars) === undefined;
      const starsLanded = () => ownStars || typeof scene.skyBox?.sources?.positiveX !== "string";
      const ready = () => !cc.sats.building && (!cc.skyView.active || cc.skyView.settled) && starsLanded();
      // The link applies first: its groups, layers and camera. Then the clock stops on its moment.
      await sceneSettled(scene, { minMs: 2000, maxMs: 30_000, ready });
      cc.viewer.clockViewModel.shouldAnimate = false;
      cc.setTime(at);
      // A sky view's terrain refines a level at a time, a few seconds a tile.
      await sceneSettled(scene, { minMs: 5000, maxMs: 90_000, ready });
      // sceneSettled gives up at maxMs, which a busy machine reaches with the star map still out.
      if (!scene.globe.tilesLoaded || !ready()) {
        return { unsettled: true };
      }
      return readNextFrame(scene, (canvas) => {
        const out = document.createElement("canvas");
        out.width = size.width;
        out.height = size.height;
        const context = out.getContext("2d");
        context.fillStyle = BACKDROP;
        context.fillRect(0, 0, size.width, size.height);
        context.imageSmoothingQuality = "high";
        context.drawImage(canvas, 0, 0, size.width, size.height);
        return { canvas: [canvas.width, canvas.height], dataUrl: out.toDataURL("image/webp", quality) };
      });
    },
    { at: bookmark.pictureAt, stars: bookmark.stars, size: PICTURE, quality: QUALITY },
  );
}

/** Takes `bookmark`'s picture and writes it; false if there was none to take. */
async function take(context, base, bookmark) {
  const url = pictureUrl(base, bookmark);
  console.log(`${bookmark.name} (${bookmark.preset}, ${bookmark.pictureAt}): ${url}`);
  const days = Math.abs(Date.now() - Date.parse(bookmark.pictureAt)) / 86_400_000;
  if (days > DRIFT_DAYS) {
    console.warn(`  ${Math.round(days)} days from now: a low orbit not in pinned.json is drawn away from where it was then`);
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => console.warn(`  page error: ${error.message}`));
  try {
    await page.goto(url);
    const taken = await picture(page, bookmark);
    const expected = [VIEWPORT.width * SCALE, VIEWPORT.height * SCALE];
    if (!taken || taken.unsettled || taken.canvas.join() !== expected.join()) {
      const why = !taken ? "no frame came" : taken.unsettled ? "the scene had not settled in 90 s" : `the canvas is ${taken.canvas.join("×")}, not ${expected.join("×")}`;
      console.error(`  no picture: ${why}`);
      return false;
    }
    write(bookmark.file, taken.dataUrl);
    return true;
  } finally {
    await page.close();
  }
}

/** Writes a data url's bytes to `file`, and says how many. */
function write(file, dataUrl) {
  const data = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`  ${path.relative(repoRoot, file)} (${Math.round(data.length / 1024)} kB)`);
}

const missing = GENERATED.filter(([dir, extension]) => !holds(path.join(repoRoot, dir), extension));
if (missing.length > 0) {
  console.error(`The pictures would lack generated data. Run ${missing.map(([, , command]) => command).join(" and ")} first.`);
  process.exit(1);
}
const bookmarks = featuredBookmarks(process.argv.slice(2));
if (bookmarks.length === 0) {
  console.error("No featured bookmark to picture.");
  process.exit(1);
}

const stopProxy = await startProxy(process.env.SATVIS_API_PROXY ?? "https://satvis.space");
// Read by vite.config.ts as the server starts.
process.env.SATVIS_API_PROXY = PROXY_URL;
const server = await createServer({ root: repoRoot, server: { port: 0, strictPort: false }, logLevel: "warn" });
await server.listen();
const base = server.resolvedUrls.local[0];
// As the e2e suite's gpu project: full Chromium in new headless mode on the local GPU.
const browser = await chromium.launch({ channel: "chromium", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
let failed = false;
try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  for (const bookmark of bookmarks) {
    // One at a time: each scene has the GPU to itself while it settles.
    // eslint-disable-next-line no-await-in-loop
    failed = !(await take(context, base, bookmark)) || failed;
  }
} finally {
  await browser.close();
  await server.close();
  stopProxy();
}
process.exit(failed ? 1 : 0);
