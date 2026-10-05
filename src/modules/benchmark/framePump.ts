// `?framems=N` drives frames for a hidden page, where Chrome suspends rAF and so
// the globe and the satellite build never run. A MessageChannel is the one
// scheduler a hidden page does not throttle: `setTimeout` clamps to 1 s and worker
// messages to ~100 ms. It keeps a core busy. Under the pump `fps` and `frameMs`
// measure the pump, not a display; see the README.

import type { Viewer } from "@cesium/widgets";

/** Stands in for a 60 Hz display. */
const DEFAULT_FRAME_MS = 16;

/** A bare or invalid value means 16 ms; `0` and `false` mean off. */
export function requestedFrameMs(search: string): number | undefined {
  const value = new URLSearchParams(search).get("framems");
  if (value === null || value === "0" || value === "false") {
    return undefined;
  }
  const frameMs = Number(value);
  return Number.isFinite(frameMs) && frameMs > 0 ? frameMs : DEFAULT_FRAME_MS;
}

export interface FrameQueue {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
  /** @returns whether a frame was due and ran. */
  runDue(): boolean;
}

/**
 * The queue behind the replacement `requestAnimationFrame`. It takes the due
 * callbacks before running any, because Cesium requests the next frame from
 * inside the current one. A callback that throws does not stop the others.
 */
export function frameQueue(frameMs: number, now: () => number): FrameQueue {
  let entries: Array<{ handle: number; callback: FrameRequestCallback }> = [];
  let nextHandle = 1;
  let lastFrame = Number.NEGATIVE_INFINITY;

  return {
    request(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      entries.push({ handle, callback });
      return handle;
    },
    cancel(handle) {
      entries = entries.filter((entry) => entry.handle !== handle);
    },
    runDue() {
      const timestamp = now();
      if (timestamp - lastFrame < frameMs) {
        return false;
      }
      lastFrame = timestamp;
      const due = entries;
      entries = [];
      for (const entry of due) {
        try {
          entry.callback(timestamp);
        } catch (error) {
          console.error("[framePump] a frame callback threw", error);
        }
      }
      return true;
    },
  };
}

let uninstall: (() => void) | undefined;

/**
 * @returns the undo, or undefined when not requested or already running.
 *
 * Calls `resize` and `render` itself (Cesium's manual-loop mode). Toggling
 * `useDefaultRenderLoop` alone is a no-op: a suspended loop never cleared its
 * running flag, so the setter does not start a new one.
 */
export function installFramePumpIfRequested(viewer: Viewer, search: string): (() => void) | undefined {
  const frameMs = requestedFrameMs(search);
  if (uninstall || frameMs === undefined) {
    return undefined;
  }

  const queue = frameQueue(frameMs, () => performance.now());
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => queue.request(callback);
  window.cancelAnimationFrame = (handle) => queue.cancel(handle);

  viewer.useDefaultRenderLoop = false;

  let running = true;
  let warnedAboutSize = false;
  const channel = new MessageChannel();
  const pump = (): void => {
    if (!running) {
      return;
    }
    if (queue.runDue()) {
      try {
        viewer.resize();
        viewer.render();
        // A 0 px canvas renders nothing silently, and every row reads zero. A pane
        // that has not laid out its tab needs a resize or a screenshot to fix it.
        if (!warnedAboutSize && viewer.scene.canvas.clientWidth === 0) {
          warnedAboutSize = true;
          console.warn("[framePump] the canvas is 0 px wide, so nothing is being drawn and every measurement will be zero. Give the page a viewport.");
        }
      } catch (error) {
        console.error("[framePump] the render threw; stopping", error);
        running = false;
        return;
      }
    }
    channel.port2.postMessage(0);
  };
  // `addEventListener` needs an explicit `start`, unlike `onmessage`.
  channel.port1.addEventListener("message", pump);
  channel.port1.start();
  channel.port2.postMessage(0);

  console.log(`[framePump] driving frames every ${frameMs} ms — fps and frameMs are this pump, not a display`);

  uninstall = () => {
    running = false;
    channel.port1.removeEventListener("message", pump);
    channel.port1.close();
    window.requestAnimationFrame = nativeRequest;
    window.cancelAnimationFrame = nativeCancel;
    viewer.useDefaultRenderLoop = true;
    uninstall = undefined;
  };
  return uninstall;
}
