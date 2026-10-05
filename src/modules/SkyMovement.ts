// Walking the observer around while the sky view is up.
//
// Keys are read from `window`: the canvas takes no keyboard focus, and a tabindex
// would add a focus ring and change Tab app-wide. Hence the typing check in `press`.
// The view moves every frame, but `onMove` (a ground station move) waits for the
// keys to be still; see docs/adr/0003-sky-view.md.

import { Math as CesiumMath } from "@cesium/engine";

import type { Aim, Observer } from "./skyGeometry";
import { offsetObserver } from "./skyGeometry";

/** Keyed by `code`, the physical key, so WASD keeps its shape on azerty and qwertz. */
const MOVEMENT_KEYS: Record<string, { forward?: number; right?: number; up?: number }> = {
  KeyW: { forward: 1 },
  KeyS: { forward: -1 },
  KeyA: { right: -1 },
  KeyD: { right: 1 },
  KeyE: { up: 1 },
  KeyQ: { up: -1 },
};

/** In metres per second. */
export const WALK_SPEED = 20;

/** At 8x, about a minute per kilometre: the range over which the sky visibly changes. */
export const SPRINT_FACTOR = 8;

/** A frame this long is a tab coming back, not a step. */
const MAX_STEP_MS = 100;

/** Rides out the gap between two taps of a key. */
export const SETTLE_MS = 350;

/** Structural, so a test needs no DOM. `target` is duck-typed by `isTyping`. */
export interface KeyPress {
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target?: unknown;
}

export interface WalkableView {
  readonly settled: boolean;
  readonly observer: Observer | undefined;
  readonly aim: Readonly<Aim>;
  eyeHeight: number;
  moveObserver(observer: Observer): void;
  remeasureGround(): void;
}

export interface SkyMovementOptions {
  skyView: WalkableView;
  /** Called once the keys have been still for `SETTLE_MS`. */
  onMove?: (observer: Observer) => void;
}

function isTyping(target: unknown): boolean {
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null | undefined;
  return element?.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(String(element?.tagName ?? ""));
}

/**
 * In metres east, north and up. Forward follows the azimuth only, never the pitch:
 * the view mostly looks up, and the up and down keys handle climbing.
 */
export function walkOffset(held: Iterable<string>, azimuth: number, seconds: number, sprint = false): { east: number; north: number; up: number } {
  let forward = 0;
  let right = 0;
  let up = 0;
  for (const code of held) {
    const axis = MOVEMENT_KEYS[code];
    forward += axis?.forward ?? 0;
    right += axis?.right ?? 0;
    up += axis?.up ?? 0;
  }

  const distance = WALK_SPEED * (sprint ? SPRINT_FACTOR : 1) * seconds;
  // Normalised so a diagonal is not faster. Across the ground only: climbing is a separate movement.
  const diagonal = Math.hypot(forward, right);
  if (diagonal > 0) {
    forward /= diagonal;
    right /= diagonal;
  }

  const radians = CesiumMath.toRadians(azimuth);
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  return {
    east: (forward * sin + right * cos) * distance,
    north: (forward * cos - right * sin) * distance,
    up: up * distance,
  };
}

export class SkyMovement {
  #options: SkyMovementOptions;

  /** By `code`. */
  #held = new Set<string>();

  #sprint = false;

  #lastStep: number | undefined;

  /** When an unreported walk becomes reportable. Pushed forward on every frame a key is held. */
  #settleAt: number | undefined;

  #listening = false;

  constructor(options: SkyMovementOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#listening) {
      return;
    }
    this.#listening = true;
    window.addEventListener("keydown", this.#onKeyDown);
    window.addEventListener("keyup", this.#onKeyUp);
    // A key held across an alt-tab never sends its keyup here.
    window.addEventListener("blur", this.#onBlur);
  }

  stop(): void {
    if (!this.#listening) {
      return;
    }
    this.#listening = false;
    window.removeEventListener("keydown", this.#onKeyDown);
    window.removeEventListener("keyup", this.#onKeyUp);
    window.removeEventListener("blur", this.#onBlur);
    this.#release();
    // An unsettled walk is dropped: a station move mid-exit would trigger an
    // `enter` and turn the flight around.
    this.#settleAt = undefined;
    this.#lastStep = undefined;
  }

  /** Public so the walk can be driven without a DOM. */
  press(event: KeyPress): void {
    this.#sprint = event.shiftKey;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      // A modifier means a shortcut, and the keyup may go to whatever it opens.
      this.#release();
      return;
    }
    if (!(event.code in MOVEMENT_KEYS) || isTyping(event.target)) {
      return;
    }
    this.#held.add(event.code);
  }

  /** Unconditional: a key that never comes back up walks forever. */
  release(event: KeyPress): void {
    this.#sprint = event.shiftKey;
    this.#held.delete(event.code);
  }

  /**
   * Driven from the caller's per-frame callback, so there is one frame clock.
   * `now` is wall time: metres per second are the user's seconds, whatever the clock multiplier.
   */
  step(now: number): void {
    const elapsed = this.#lastStep === undefined ? 0 : Math.min(now - this.#lastStep, MAX_STEP_MS);
    this.#lastStep = now;

    const { skyView } = this.#options;
    // During a flight the observer and the aim are the destination, not where the view is.
    if (!skyView.settled) {
      return;
    }

    if (this.#held.size > 0) {
      this.#walk(elapsed / 1000);
      this.#settleAt = now + SETTLE_MS;
      return;
    }
    if (this.#settleAt === undefined || now < this.#settleAt) {
      return;
    }
    this.#settleAt = undefined;

    // The walk's height was measured on a throttle, so measure the final one. The
    // station move cannot do it: a walk below the store's precision writes nothing.
    skyView.remeasureGround();
    const observer = skyView.observer;
    if (observer) {
      this.#options.onMove?.(observer);
    }
  }

  #walk(seconds: number): void {
    const { skyView } = this.#options;
    const observer = skyView.observer;
    if (!observer || seconds <= 0) {
      return;
    }
    const { east, north, up } = walkOffset(this.#held, skyView.aim.azimuth, seconds, this.#sprint);
    if (east !== 0 || north !== 0) {
      skyView.moveObserver(offsetObserver(observer, east, north));
    }
    if (up !== 0) {
      skyView.eyeHeight += up;
    }
  }

  /** Leaves `#settleAt` alone: releasing the keys ends a walk, it does not cancel it. */
  #release(): void {
    this.#held.clear();
    this.#sprint = false;
  }

  #onKeyDown = (event: KeyboardEvent): void => this.press(event);

  #onKeyUp = (event: KeyboardEvent): void => this.release(event);

  #onBlur = (): void => this.#release();
}
