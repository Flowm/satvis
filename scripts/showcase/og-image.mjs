// Draws the link preview that index.html and about.html name as og:image: the logo and the
// name above the globe's showcase picture, 1200×630 as Open Graph and X's large card want it.
// All of it sits in the middle 630×630, which WhatsApp and Telegram crop their square
// thumbnails from. `pnpm update-showcase` redraws it whenever it retakes the globe;
// `node scripts/showcase/og-image.mjs` redraws it alone.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(repoRoot, "public", "og-image.webp");

/** The showcase picture the card is drawn around, which capture.mjs redraws the card after. */
export const OG_IMAGE_SOURCE = path.join(repoRoot, "public", "showcase", "globe.webp");

/** The pages whose og:image carries the card's version. */
const PAGES = ["index.html", "about.html"];

/** The size index.html states in og:image:width and og:image:height. */
const SIZE = { width: 1200, height: 630 };

/**
 * The showcase pictures' quality. Measured on this card: 32 kB, as close to the lossless render
 * as a JPEG at 85 of 63 kB, and a PNG was 324 kB, past the 300 kB WhatsApp drops previews at.
 */
const QUALITY = 0.8;

/**
 * Facebook keeps a card by its url until the url changes, LinkedIn and X for about a week.
 * The first 8 hex digits of its SHA-256, which a Git LFS pointer records as its `oid`.
 */
export const ogImageVersion = (sha256) => sha256.slice(0, 8);

const dataUrl = (file, type) => `data:${type};base64,${fs.readFileSync(file).toString("base64")}`;

const html = () => `<!doctype html>
<style>
  html, body { margin: 0; width: ${SIZE.width}px; height: ${SIZE.height}px; overflow: hidden; background: #000; }
  .globe { position: absolute; top: 214px; left: -204px; width: 1600px; }
  .fade { position: absolute; inset: 0; background: linear-gradient(#000 0, #000 34%, #0000 52%); }
  .text { position: absolute; inset: 56px 0 auto; display: flex; flex-direction: column; align-items: center; color: #fff; font-family: "Helvetica Neue", Arial, sans-serif; }
  .name { display: flex; align-items: center; gap: 24px; font-size: 96px; font-weight: 700; letter-spacing: -2px; }
  .name img { width: 100px; height: 100px; border-radius: 22px; }
  .tagline { margin-top: 14px; font-size: 32px; color: #fff3e0; }
</style>
<img class="globe" src="${dataUrl(OG_IMAGE_SOURCE, "image/webp")}" />
<div class="fade"></div>
<div class="text">
  <div class="name"><img src="${dataUrl(path.join(repoRoot, "public", "logo.svg"), "image/svg+xml")}" />Satvis</div>
  <div class="tagline">3D satellite tracker &amp; sky view</div>
</div>`;

/** The card as WebP bytes, drawn in a page of `browser`. */
async function draw(browser) {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  try {
    await page.setContent(html(), { waitUntil: "load" });
    // Playwright screenshots only as PNG or JPEG; the page's canvas encodes WebP.
    const png = `data:image/png;base64,${(await page.screenshot()).toString("base64")}`;
    const webp = await page.evaluate(
      async ({ src, quality }) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext("2d").drawImage(image, 0, 0);
        return canvas.toDataURL("image/webp", quality);
      },
      { src: png, quality: QUALITY },
    );
    return Buffer.from(webp.slice(webp.indexOf(",") + 1), "base64");
  } finally {
    await page.close();
  }
}

/** Points each page's og:image at `version`. */
function stamp(version) {
  for (const name of PAGES) {
    const file = path.join(repoRoot, name);
    const pattern = /(content="https:\/\/satvis\.space\/og-image\.webp)(\?v=[0-9a-f]+)?"/g;
    const before = fs.readFileSync(file, "utf8");
    if ((before.match(pattern) ?? []).length !== 1) {
      throw new Error(`${name}: expected one og:image of https://satvis.space/og-image.webp`);
    }
    fs.writeFileSync(file, before.replace(pattern, `$1?v=${version}"`));
  }
}

/**
 * Redraws the card and points the pages at its new version. Always in a headless shell of its
 * own: capture.mjs's Chromium on the GPU encoded the same card to other bytes, a new version.
 */
export async function drawOgImage() {
  const browser = await chromium.launch();
  try {
    const data = await draw(browser);
    fs.writeFileSync(OUT, data);
    const version = ogImageVersion(createHash("sha256").update(data).digest("hex"));
    stamp(version);
    console.log(`${path.relative(repoRoot, OUT)} (${Math.round(data.length / 1024)} kB), version ${version} in ${PAGES.join(" and ")}`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await drawOgImage();
}
