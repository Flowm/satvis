import { Cartesian2 } from "@cesium/core";
import type { CesiumWidget, Scene } from "@cesium/engine";
import { describe, expect, it } from "vitest";

import { reportableError, skipUnsizedFrames, skipUnsizedPicks } from "./CesiumController";

/**
 * A fake widget that counts renders and ticks. The `render` of Cesium ticks the
 * clock itself, so the guard must keep the tick count equal after a skip.
 */
function fakeWidget(width: number, height: number) {
  const state = { renders: 0, ticks: 0, width, height };

  const widget = {
    scene: {
      get drawingBufferWidth() {
        return state.width;
      },
      get drawingBufferHeight() {
        return state.height;
      },
    },
    clock: {
      tick() {
        state.ticks += 1;
      },
    },
    render() {
      state.renders += 1;
      state.ticks += 1;
    },
  };

  return { widget: widget as unknown as CesiumWidget, state };
}

describe("skipUnsizedFrames", () => {
  it("draws when the drawing buffer has a size", () => {
    const { widget, state } = fakeWidget(1110, 500);
    skipUnsizedFrames(widget);

    widget.render();

    expect(state.renders).toBe(1);
  });

  it.each([
    ["zero width", 0, 500],
    ["zero height", 1110, 0],
    ["zero both", 0, 0],
  ])("skips the frame on %s", (_case, width, height) => {
    const { widget, state } = fakeWidget(width, height);
    skipUnsizedFrames(widget);

    widget.render();

    expect(state.renders).toBe(0);
  });

  it("ticks the clock while it skips, so the clock stays current", () => {
    const { widget, state } = fakeWidget(0, 0);
    skipUnsizedFrames(widget);

    widget.render();
    widget.render();

    expect(state.ticks).toBe(2);
  });

  it("draws again after the canvas has a size, and does not stay off", () => {
    const { widget, state } = fakeWidget(0, 0);
    skipUnsizedFrames(widget);

    widget.render();
    state.width = 1110;
    state.height = 500;
    widget.render();

    expect(state.renders).toBe(1);
    expect(state.ticks).toBe(2);
  });
});

describe("skipUnsizedPicks", () => {
  /** A fake scene whose pick throws without a drawing buffer, as Cesium's pick frustum does. */
  function fakeScene(width: number, height: number) {
    const scene = {
      drawingBufferWidth: width,
      drawingBufferHeight: height,
      pick(this: unknown) {
        if (scene.drawingBufferWidth === 0 || scene.drawingBufferHeight === 0) {
          throw new Error("drawingBufferWidth must be greater than zero.");
        }
        return { id: "picked", self: this };
      },
    };
    return scene as unknown as Scene & { drawingBufferWidth: number; drawingBufferHeight: number };
  }

  it("picks as Cesium does while the drawing buffer has a size", () => {
    const scene = fakeScene(1110, 500);
    skipUnsizedPicks(scene);

    expect(scene.pick(new Cartesian2(1, 1))).toEqual({ id: "picked", self: scene });
  });

  it.each([
    ["zero width", 0, 500],
    ["zero height", 1110, 0],
    ["zero both", 0, 0],
  ])("picks nothing, and does not throw, on %s", (_case, width, height) => {
    const scene = fakeScene(width, height);
    skipUnsizedPicks(scene);

    expect(scene.pick(new Cartesian2(1, 1))).toBeUndefined();
  });

  it("picks again after the canvas has a size", () => {
    const scene = fakeScene(0, 0);
    skipUnsizedPicks(scene);

    scene.pick(new Cartesian2(1, 1));
    scene.drawingBufferWidth = 1110;
    scene.drawingBufferHeight = 500;

    expect(scene.pick(new Cartesian2(1, 1))).toEqual({ id: "picked", self: scene });
  });
});

describe("reportableError", () => {
  it("keeps an Error without a change", () => {
    const error = new RangeError("Expected width to be greater than 0");

    expect(reportableError(error, "An error occurred while rendering.")).toBe(error);
  });

  it("describes a non-Error with the title and message from Cesium", () => {
    // What an imagery provider gives the panel: no message, no stack.
    const requestErrorEvent = { statusCode: 404, response: undefined, responseHeaders: {} };

    const reported = reportableError(requestErrorEvent, 'An error occurred in "ImageryLayer"', "Failed to obtain image tile X: 1 Y: 2 Level: 3.");

    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe('Cesium: An error occurred in "ImageryLayer" — Failed to obtain image tile X: 1 Y: 2 Level: 3.');
    expect(reported.cause).toBe(requestErrorEvent);
  });

  it("uses only the title when Cesium gives no message", () => {
    expect(reportableError({}, "An error occurred while rendering.").message).toBe("Cesium: An error occurred while rendering.");
  });

  it("gives a message when Cesium gives neither", () => {
    expect(reportableError({}, "").message).toBe("Cesium: render error");
  });
});
