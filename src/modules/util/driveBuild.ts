// An asynchronous Primitive advances only from `update`, which the scene calls on
// rendered frames. Driven from clock ticks instead, outside the scene, it finishes under
// render-on-demand and replaces the old primitive in a single frame, with no gap.

import type { Primitive } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

/** Report once, not on every tick. */
let reportedMissingState = false;

/** Once a session, so the error does not flood the console. */
function reportMissingState(): void {
  if (reportedMissingState) {
    return;
  }
  reportedMissingState = true;
  console.error("Cesium Primitive has no _state; driving it every tick instead. Cesium internals have moved — see driveBuild.");
}

/** What becomes of a build: the primitive for the caller to add to the scene, or nothing. */
export interface BuildOutcome {
  /** The primitive is built, for the caller to add to the scene. */
  ready(): void;
  /** The primitive failed and is destroyed. */
  failed(): void;
}

/**
 * Calls `ready` on the tick the primitive finishes. A failed one reports itself ready too,
 * and would throw from every `update` in the scene and stop the render loop, so it goes
 * to `failed` instead, as does a build that throws.
 */
export function driveBuild(viewer: Viewer, primitive: Primitive, outcome: BuildOutcome): void {
  let lastState = -1;
  const update = (): void => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (primitive as any).update(viewer.scene.frameState);
    } catch (error) {
      console.error("A batched primitive failed to build", error);
      removeCallback();
      primitive.destroy();
      outcome.failed();
      return;
    }
    // Cesium marks the primitive ready after the next render, which a paused clock never asks for.
    viewer.scene.requestRender();
  };
  const removeCallback = viewer.clock.onTick.addEventListener(() => {
    if (!primitive.ready) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (primitive as any)._state;
      if (state === undefined) {
        // `_state` is Cesium-internal. Without it, `update` would run once and the build
        // would never finish, silently hanging every scene morph. Report it and drive the
        // primitive anyway.
        reportMissingState();
        update();
        return;
      }
      if (state !== lastState) {
        lastState = state;
        update();
      }
      return;
    }
    removeCallback();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((primitive as any)._error !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.error("A batched primitive failed to build", (primitive as any)._error);
      primitive.destroy();
      outcome.failed();
      return;
    }
    outcome.ready();
  });
}
