// The walk, driven through `press`/`release`/`step` as the frame loop drives it.

import { Cartesian3 } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { type Observer, offsetObserver } from "./skyGeometry";
import { SETTLE_MS, SkyMovement, SPRINT_FACTOR, WALK_SPEED, type WalkableView } from "./SkyMovement";

const key = (code: string, shiftKey = false) => ({ code, shiftKey, ctrlKey: false, metaKey: false, altKey: false });

const MUNICH: Observer = { lat: 48.1372, lon: 11.5756 };

/** Records instead of moving a camera. */
function fakeView(overrides: Partial<WalkableView> = {}) {
  const view = {
    settled: true,
    observer: MUNICH as Observer | undefined,
    aim: { azimuth: 0, pitch: 30, roll: 0 },
    eyeHeight: 2,
    remeasures: 0,
    moveObserver(observer: Observer) {
      view.observer = observer;
    },
    remeasureGround() {
      view.remeasures += 1;
    },
    ...overrides,
  };
  return view;
}

/** On the ellipsoid at sea level. */
const metresBetween = (from: Observer, to: Observer): number => Cartesian3.distance(Cartesian3.fromDegrees(from.lon, from.lat), Cartesian3.fromDegrees(to.lon, to.lat));

/** Holds the keys for `seconds` across several frames: a step longer than a frame is capped. */
function walk(codes: string[], view = fakeView(), { shift = false, seconds = 1, frames = 20 } = {}) {
  const movement = new SkyMovement({ skyView: view as unknown as WalkableView });
  let now = 1000;
  movement.step(now);
  for (const code of codes) {
    movement.press(key(code, shift));
  }
  const stepMs = (seconds * 1000) / frames;
  for (let frame = 0; frame < frames; frame += 1) {
    now += stepMs;
    movement.step(now);
  }
  return { movement, view, now };
}

describe("walking", () => {
  test("W goes the way the view is facing, at the walking speed", () => {
    const { view } = walk(["KeyW"]);

    expect(metresBetween(MUNICH, view.observer!)).toBeCloseTo(WALK_SPEED, 1);
    // Facing north, so due north.
    expect(metresBetween(offsetObserver(MUNICH, 0, WALK_SPEED), view.observer!)).toBeLessThan(0.01);
  });

  test("S goes the other way, and D strafes to the right of the aim", () => {
    const back = walk(["KeyS"]).view;
    expect(metresBetween(offsetObserver(MUNICH, 0, -WALK_SPEED), back.observer!)).toBeLessThan(0.01);

    const right = walk(["KeyD"]).view;
    expect(metresBetween(offsetObserver(MUNICH, WALK_SPEED, 0), right.observer!)).toBeLessThan(0.01);
  });

  test("forward follows the aim rather than the compass", () => {
    // Facing east: W is east, and A — to the left of the aim — is north.
    const east = walk(["KeyW"], fakeView({ aim: { azimuth: 90, pitch: 30, roll: 0 } })).view;
    expect(metresBetween(offsetObserver(MUNICH, WALK_SPEED, 0), east.observer!)).toBeLessThan(0.01);

    const left = walk(["KeyA"], fakeView({ aim: { azimuth: 90, pitch: 30, roll: 0 } })).view;
    expect(metresBetween(offsetObserver(MUNICH, 0, WALK_SPEED), left.observer!)).toBeLessThan(0.01);
  });

  test("looking up does not walk into the sky", () => {
    // W at 80° pitch would otherwise be a takeoff.
    const steep = walk(["KeyW"], fakeView({ aim: { azimuth: 0, pitch: 80, roll: 0 } })).view;

    expect(metresBetween(MUNICH, steep.observer!)).toBeCloseTo(WALK_SPEED, 1);
    expect(steep.eyeHeight).toBe(2);
  });

  test("a diagonal is not a shortcut to going faster", () => {
    const { view } = walk(["KeyW", "KeyD"]);
    expect(metresBetween(MUNICH, view.observer!)).toBeCloseTo(WALK_SPEED, 1);
  });

  test("opposite keys cancel", () => {
    const { view } = walk(["KeyW", "KeyS"]);
    expect(metresBetween(MUNICH, view.observer!)).toBeLessThan(0.01);
  });

  test("E lifts the eye and Q sets it back down, without moving across the ground", () => {
    const up = walk(["KeyE"]).view;
    expect(up.eyeHeight).toBeCloseTo(2 + WALK_SPEED, 6);
    expect(metresBetween(MUNICH, up.observer!)).toBeLessThan(0.01);

    const down = walk(["KeyQ"], fakeView({ eyeHeight: 100 })).view;
    expect(down.eyeHeight).toBeCloseTo(100 - WALK_SPEED, 6);
  });

  test("shift covers ground", () => {
    const { view } = walk(["KeyW"], fakeView(), { shift: true });
    expect(metresBetween(MUNICH, view.observer!)).toBeCloseTo(WALK_SPEED * SPRINT_FACTOR, 0);
  });

  test("the distance is the same however the second is cut into frames", () => {
    const few = walk(["KeyW"], fakeView(), { frames: 10 }).view;
    const many = walk(["KeyW"], fakeView(), { frames: 120 }).view;

    expect(metresBetween(MUNICH, few.observer!)).toBeCloseTo(WALK_SPEED, 1);
    expect(metresBetween(MUNICH, many.observer!)).toBeCloseTo(WALK_SPEED, 1);
  });

  test("a tab coming back does not teleport", () => {
    // A ten-second frame is a window that was not rendered, not ten seconds of walking.
    const view = fakeView();
    const movement = new SkyMovement({ skyView: view as unknown as WalkableView });
    movement.step(0);
    movement.press(key("KeyW"));
    movement.step(10_000);

    expect(metresBetween(MUNICH, view.observer!)).toBeLessThanOrEqual(WALK_SPEED * 0.1);
  });

  test("nothing moves until the camera has landed", () => {
    const view = fakeView({ settled: false });
    const movement = new SkyMovement({ skyView: view as unknown as WalkableView });
    movement.step(0);
    movement.press(key("KeyW"));
    movement.step(1000);

    expect(view.observer).toBe(MUNICH);
  });
});

describe("which keys count", () => {
  test("a key typed into a text field is not a step", () => {
    const view = fakeView();
    const movement = new SkyMovement({ skyView: view as unknown as WalkableView });
    movement.step(0);
    movement.press({ ...key("KeyW"), target: { tagName: "INPUT" } });
    movement.press({ ...key("KeyD"), target: { isContentEditable: true } });
    movement.step(1000);

    expect(view.observer).toBe(MUNICH);
  });

  test("a shortcut stops the walk rather than joining it", () => {
    // The keyup for a key already down may go to whatever the shortcut opens.
    const view = fakeView();
    const movement = new SkyMovement({ skyView: view as unknown as WalkableView });
    movement.step(0);
    movement.press(key("KeyW"));
    movement.press({ ...key("KeyR"), ctrlKey: true });
    movement.step(1000);

    expect(view.observer).toBe(MUNICH);
  });

  test("a key released while typing is still released", () => {
    const view = fakeView();
    const movement = new SkyMovement({ skyView: view as unknown as WalkableView });
    movement.step(0);
    movement.press(key("KeyW"));
    // Focus moved into a field mid-press, so the keyup comes from there.
    movement.release({ ...key("KeyW"), target: { tagName: "INPUT" } });
    movement.step(1000);

    expect(view.observer).toBe(MUNICH);
  });
});

describe("settling", () => {
  test("the walk is reported once the keys have been still", () => {
    const moves: Observer[] = [];
    const view = fakeView();
    const movement = new SkyMovement({ skyView: view as unknown as WalkableView, onMove: (observer) => moves.push(observer) });
    movement.step(0);
    movement.press(key("KeyW"));
    movement.step(500);

    // Still walking: a station move per frame would recompute every pass.
    expect(moves).toEqual([]);

    movement.release(key("KeyW"));
    movement.step(600);
    expect(moves).toEqual([]);

    movement.step(600 + SETTLE_MS);
    expect(moves).toEqual([view.observer]);
    // The throttled height is replaced by a final measurement.
    expect(view.remeasures).toBe(1);

    movement.step(5000);
    expect(moves).toHaveLength(1);
  });

  test("a pause shorter than the settle does not split one walk into two", () => {
    const moves: Observer[] = [];
    const view = fakeView();
    const movement = new SkyMovement({ skyView: view as unknown as WalkableView, onMove: (observer) => moves.push(observer) });
    movement.step(0);
    movement.press(key("KeyW"));
    movement.step(100);
    movement.release(key("KeyW"));
    movement.step(200);
    movement.press(key("KeyW"));
    movement.step(300);
    movement.release(key("KeyW"));
    movement.step(400);
    movement.step(400 + SETTLE_MS);

    expect(moves).toHaveLength(1);
  });

  test("nothing is reported when nothing walked", () => {
    const moves: Observer[] = [];
    const view = fakeView();
    const movement = new SkyMovement({ skyView: view as unknown as WalkableView, onMove: (observer) => moves.push(observer) });
    for (let now = 0; now < 5000; now += 100) {
      movement.step(now);
    }

    expect(moves).toEqual([]);
    expect(view.remeasures).toBe(0);
  });
});
