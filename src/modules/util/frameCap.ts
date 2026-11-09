// Cesium's own cap (`targetFrameRate`) draws once a whole interval has passed and carries the
// remainder into the next frame. Jitter needs the cap a hair over the refresh, and the carry then
// grows until a frame comes a refresh early: 60 × 1.05 drew 63 a second on a 120 Hz Mac, one
// frame in ten after 8 ms, and the performance panel read 63.

import type { CesiumWidget } from "@cesium/engine";

/** How early a refresh may come and still draw: over Safari's whole-millisecond jitter, under a refresh at 240 Hz. */
const EARLY_MS = 3;

/**
 * Draws on the first refresh at most `EARLY_MS` before each due time, the due times an interval
 * apart. A cap that divides the screen's rate draws evenly, every second refresh at 60 on 120 Hz;
 * any other draws its rate on average.
 */
export class FrameCap {
  /** Undefined draws every refresh. */
  intervalMs: number | undefined;

  /** When the next frame is due. */
  #due = Number.NEGATIVE_INFINITY;

  /** Whether the refresh at `frameTime`, a `requestAnimationFrame` timestamp, draws. */
  draws(frameTime: number): boolean {
    if (this.intervalMs === undefined) {
      return true;
    }
    if (frameTime < this.#due - EARLY_MS) {
      return false;
    }
    this.#due += this.intervalMs;
    // Behind by an interval, after a long frame or a hidden tab: start over rather than catch up.
    if (this.#due - EARLY_MS <= frameTime) {
      this.#due = frameTime + this.intervalMs;
    }
    return true;
  }
}

/** A render loop started by `startRenderLoop`. */
export interface RenderLoop {
  /** False once stopped, or once a render threw. */
  readonly running: boolean;
  /** For a driver that draws the frames itself (`framePump`). */
  stop(): void;
}

/** Cesium's render loop with `cap` in place of its own. */
export function startRenderLoop(widget: CesiumWidget, cap: FrameCap): RenderLoop {
  widget.useDefaultRenderLoop = false;
  let running = true;
  const step = (frameTime: number): void => {
    if (!running || widget.isDestroyed()) {
      return;
    }
    if (cap.draws(frameTime)) {
      try {
        widget.resize();
        widget.render();
      } catch (error) {
        // As Cesium's loop does: stop, and say so unless the widget was made not to.
        running = false;
        if ((widget as unknown as { _showRenderLoopErrors: boolean })._showRenderLoopErrors) {
          // Typed as a string, but Cesium's own loop passes the error.
          widget.showErrorPanel("An error occurred while rendering.  Rendering has stopped.", undefined, error as string);
        }
        return;
      }
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return {
    get running() {
      return running;
    },
    stop() {
      running = false;
    },
  };
}
