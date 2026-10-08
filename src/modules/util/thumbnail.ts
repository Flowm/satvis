// A small picture of the globe, for a bookmark's card.

import type { Scene } from "@cesium/engine";

/** Wide enough for a card at twice the CSS pixels. */
const THUMBNAIL_WIDTH = 320;
/** The space behind a transparent globe canvas, which the page's background shows through. */
const BACKDROP = "#0b0f14";
/** A frame that never comes, such as in a background tab, gives up rather than hang. */
const FRAME_TIMEOUT_MS = 2000;

/**
 * The next frame as a data url, or undefined if no frame came. Read inside `postRender`,
 * where the drawing buffer is still intact without `preserveDrawingBuffer`, which would
 * cost every frame a copy.
 */
export function captureThumbnail(scene: Scene): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      remove();
      resolve(undefined);
    }, FRAME_TIMEOUT_MS);
    const remove = scene.postRender.addEventListener(() => {
      remove();
      clearTimeout(timeout);
      resolve(drawThumbnail(scene.canvas));
    });
    scene.requestRender();
  });
}

/** `source` scaled to the thumbnail width on the backdrop, or undefined for an empty canvas. */
function drawThumbnail(source: HTMLCanvasElement): string | undefined {
  if (source.width === 0 || source.height === 0) {
    return undefined;
  }
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = Math.round((source.height * THUMBNAIL_WIDTH) / source.width);
  const context = canvas.getContext("2d");
  if (!context) {
    return undefined;
  }
  context.fillStyle = BACKDROP;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  // Safari encodes no WebP and returns a PNG, several times the size.
  const webp = canvas.toDataURL("image/webp", 0.7);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.75);
}

/**
 * Resolves once the globe has loaded its tiles and `ready` holds, no sooner than `minMs`
 * so a camera flight can land, and no later than `maxMs`.
 */
export function sceneSettled(scene: Scene, { minMs, maxMs, ready = () => true }: { minMs: number; maxMs: number; ready?: () => boolean }): Promise<void> {
  const start = performance.now();
  return new Promise((resolve) => {
    // With render-on-demand a still scene draws no frame to check, so ask for one.
    const poll = setInterval(() => scene.requestRender(), 500);
    const timeout = setTimeout(done, maxMs);
    const remove = scene.postRender.addEventListener(() => {
      if (performance.now() - start >= minMs && scene.globe.tilesLoaded && ready()) {
        done();
      }
    });
    function done(): void {
      remove();
      clearInterval(poll);
      clearTimeout(timeout);
      resolve();
    }
  });
}
