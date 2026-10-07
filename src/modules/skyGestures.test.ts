import { describe, expect, test } from "vitest";

import { lookAfterDrag, SkyGestures, TAP_SLOP, WHEEL_ZOOM_RATE } from "./skyGestures";

/** A recogniser over a 75° view, with the device sensor holding the aim while `held` says so. */
function gestures({ held = false, fovy = 75 } = {}) {
  const state = { held, fovy };
  const recogniser = new SkyGestures({ fovy: () => state.fovy, aimHeld: () => state.held });
  return { recogniser, state };
}

describe("SkyGestures", () => {
  test("a press that stays within the slop is a tap", () => {
    const { recogniser } = gestures();
    recogniser.down(1, 100, 100);
    recogniser.move(1, 103, 104);
    expect(recogniser.up(1)).toEqual([{ kind: "tap" }]);
  });

  test("a drag looks by every move and is no tap", () => {
    const { recogniser } = gestures();
    recogniser.down(1, 100, 100);
    expect(recogniser.move(1, 110, 95)).toEqual([{ kind: "look", dx: 10, dy: -5 }]);
    expect(recogniser.move(1, 112, 95)).toEqual([{ kind: "look", dx: 2, dy: 0 }]);
    expect(recogniser.up(1)).toEqual([]);
  });

  test("ignores a pointer that never went down, such as a hovering mouse", () => {
    const { recogniser } = gestures();
    expect(recogniser.move(1, 50, 50)).toEqual([]);
    expect(recogniser.up(1)).toEqual([]);
  });

  test("while the sensor holds the aim, a drag takes it back only past the slop", () => {
    const { recogniser, state } = gestures({ held: true });
    recogniser.down(1, 100, 100);
    expect(recogniser.move(1, 100 + TAP_SLOP, 100)).toEqual([]);

    expect(recogniser.move(1, 100 + TAP_SLOP + 2, 100)).toEqual([{ kind: "take-aim" }, { kind: "look", dx: 2, dy: 0 }]);
    state.held = false;
    expect(recogniser.move(1, 100 + TAP_SLOP + 5, 100)).toEqual([{ kind: "look", dx: 3, dy: 0 }]);
  });

  test("a pinch sets the field of view from where it started, by the finger spread", () => {
    const { recogniser } = gestures({ fovy: 60 });
    recogniser.down(1, 100, 100);
    recogniser.down(2, 200, 100);

    expect(recogniser.move(2, 300, 100)).toEqual([{ kind: "fovy", fovy: 30 }]);
    expect(recogniser.move(1, 200, 100)).toEqual([{ kind: "fovy", fovy: 60 }]);
  });

  // e2e/regressions/skyCompassDrag.spec.ts: a pinch ended compass aiming on its first pixel.
  test("a pinch leaves the sensor's aim alone, and its last finger must pass the slop to take it", () => {
    const { recogniser } = gestures({ held: true });
    recogniser.down(1, 100, 100);
    recogniser.down(2, 200, 100);
    expect(recogniser.move(2, 250, 100).map((intent) => intent.kind)).toEqual(["fovy"]);
    recogniser.up(2);

    expect(recogniser.move(1, 101, 100)).toEqual([]);
    expect(recogniser.move(1, 101 + TAP_SLOP, 100).map((intent) => intent.kind)).toEqual(["take-aim", "look"]);
  });

  test("the finger left after a pinch drags on from where it is, without a jump", () => {
    const { recogniser } = gestures();
    recogniser.down(1, 100, 100);
    recogniser.down(2, 200, 100);
    recogniser.move(1, 140, 100);
    recogniser.up(2);

    expect(recogniser.move(1, 145, 100)).toEqual([{ kind: "look", dx: 5, dy: 0 }]);
  });

  test("a pinch is never a tap, though its fingers barely moved", () => {
    const { recogniser } = gestures();
    recogniser.down(1, 100, 100);
    recogniser.down(2, 200, 100);
    recogniser.up(2);
    expect(recogniser.up(1)).toEqual([]);
  });

  test("the wheel zooms by a constant ratio a notch, and reads lines and pages as pixels", () => {
    const { recogniser } = gestures();
    expect(recogniser.wheel(-100, 0)).toEqual([{ kind: "zoom", factor: Math.exp(-100 * WHEEL_ZOOM_RATE) }]);
    expect(recogniser.wheel(3, 1)).toEqual([{ kind: "zoom", factor: Math.exp(48 * WHEEL_ZOOM_RATE) }]);
    expect(recogniser.wheel(1, 2)).toEqual([{ kind: "zoom", factor: Math.exp(100 * WHEEL_ZOOM_RATE) }]);
  });

  test("forgets a gesture the canvas was let go in the middle of", () => {
    const { recogniser } = gestures();
    recogniser.down(1, 100, 100);
    recogniser.reset();
    expect(recogniser.move(1, 150, 100)).toEqual([]);
    expect(recogniser.up(1)).toEqual([]);
  });
});

describe("lookAfterDrag", () => {
  test("turns the sky with the cursor at any zoom", () => {
    const aim = { azimuth: 180, pitch: 30, roll: 0 };
    expect(lookAfterDrag(aim, 100, 0, 75, 750)).toEqual({ azimuth: 170, pitch: 30 });
    expect(lookAfterDrag(aim, 100, 0, 7.5, 750)).toEqual({ azimuth: 179, pitch: 30 });
  });

  test("stops at the zenith and the nadir rather than flip over", () => {
    const aim = { azimuth: 0, pitch: 80, roll: 0 };
    expect(lookAfterDrag(aim, 0, 500, 75, 750).pitch).toBe(90);
    expect(lookAfterDrag({ ...aim, pitch: -80 }, 0, -500, 75, 750).pitch).toBe(-90);
  });
});
