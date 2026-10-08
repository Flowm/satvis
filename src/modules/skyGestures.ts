// The sky view's pointer and wheel gestures, as intents: what a sequence of events
// means, without a canvas or a view to apply it to. SkyInteraction binds the canvas
// and applies them.

import type { Aim } from "./skyGeometry";

/** A drag this small (CSS pixels) is a tap: it absorbs tremor but not a short flick. */
export const TAP_SLOP = 8;

/** Multiplicative, so equal gestures give equal zoom rather than equal degrees. */
export const WHEEL_ZOOM_RATE = 0.0015;

/** `deltaMode` 1 is lines and 2 is pages; normalise to pixels. */
const WHEEL_DELTA_SCALE: Record<number, number> = { 1: 16, 2: 100 };

export type GestureIntent =
  /** The pointer moved this far, in CSS pixels; see `lookAfterDrag`. */
  | { kind: "look"; dx: number; dy: number }
  /** A pinch sets the field of view outright, from where it started. */
  | { kind: "fovy"; fovy: number }
  /** The wheel scales the field of view about the crosshair. */
  | { kind: "zoom"; factor: number }
  /** A drag takes the aim back from the device sensor, which would otherwise spring the sky back. */
  | { kind: "take-aim" }
  /** Acts on what the crosshair holds, not on what is under the finger. */
  | { kind: "tap" };

interface Point {
  x: number;
  y: number;
}

/**
 * Degrees per pixel from the vertical field of view, so the sky tracks the cursor at any
 * zoom. Pitch is clamped, not wrapped: passing the zenith would flip the azimuth and the roll.
 */
export function lookAfterDrag(aim: Aim, dx: number, dy: number, fovy: number, height: number): Pick<Aim, "azimuth" | "pitch"> {
  const perPixel = fovy / (height || 1);
  return { azimuth: aim.azimuth - dx * perPixel, pitch: Math.min(90, Math.max(-90, aim.pitch + dy * perPixel)) };
}

export interface SkyGesturesOptions {
  /** The field of view a pinch starts from. */
  fovy: () => number;
  /** Whether the device sensor holds the aim, so a drag must pass the tap slop to take it. */
  aimHeld: () => boolean;
}

/** One gesture is a drag or a pinch, never both: zoom changes only the field of view. */
export class SkyGestures {
  readonly #options: SkyGesturesOptions;

  readonly #pointers = new Map<number, Point>();

  /** The pointer that drags, while one does. */
  #dragging: number | undefined;

  /** In CSS pixels. */
  #dragged = 0;

  /** Separate from `#dragged`: a pinch is not a tap, though its fingers may not have dragged. */
  #pinched = false;

  #last: Point = { x: 0, y: 0 };

  /** Latched at the pinch start: accumulating per-move ratios drifts over a long gesture. */
  #pinch: { startDistance: number; startFovy: number } | undefined;

  constructor(options: SkyGesturesOptions) {
    this.#options = options;
  }

  #pinchDistance(): number | undefined {
    const [first, second] = [...this.#pointers.values()];
    return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : undefined;
  }

  down(id: number, x: number, y: number): GestureIntent[] {
    this.#pointers.set(id, { x, y });
    if (this.#pointers.size === 2) {
      this.#dragging = undefined;
      this.#pinched = true;
      this.#pinch = { startDistance: this.#pinchDistance() ?? 1, startFovy: this.#options.fovy() };
    } else if (this.#pointers.size === 1) {
      this.#dragging = id;
      this.#dragged = 0;
      this.#pinched = false;
      this.#last = { x, y };
    }
    return [];
  }

  move(id: number, x: number, y: number): GestureIntent[] {
    if (!this.#pointers.has(id)) {
      return [];
    }
    this.#pointers.set(id, { x, y });

    if (this.#pinch) {
      const distance = this.#pinchDistance();
      // Twist is ignored: only the device sensor rolls the view.
      return distance !== undefined && distance > 0 ? [{ kind: "fovy", fovy: (this.#pinch.startFovy * this.#pinch.startDistance) / distance }] : [];
    }

    if (id !== this.#dragging) {
      return [];
    }
    const dx = x - this.#last.x;
    const dy = y - this.#last.y;
    this.#last = { x, y };
    this.#dragged += Math.abs(dx) + Math.abs(dy);

    // Only past the tap slop, so a tap can still select. A pinch's remaining finger
    // restarts `#dragged`, so that finger must also pass the slop.
    if (this.#options.aimHeld()) {
      return this.#dragged <= TAP_SLOP ? [] : [{ kind: "take-aim" }, { kind: "look", dx, dy }];
    }
    return [{ kind: "look", dx, dy }];
  }

  /** Also for `pointercancel`. */
  up(id: number): GestureIntent[] {
    if (!this.#pointers.delete(id)) {
      return [];
    }

    if (this.#pinch) {
      if (this.#pointers.size >= 2) {
        return [];
      }
      this.#pinch = undefined;
      const [remaining] = [...this.#pointers.entries()];
      if (remaining) {
        // Re-seeded, not resumed: the finger moved while pinching. `#pinched`
        // remembers this was no tap.
        this.#dragging = remaining[0];
        this.#last = remaining[1];
        this.#dragged = 0;
      }
      return [];
    }

    if (id !== this.#dragging) {
      return [];
    }
    this.#dragging = undefined;
    return this.#dragged > TAP_SLOP || this.#pinched ? [] : [{ kind: "tap" }];
  }

  /** Scrolling down widens the field of view. */
  wheel(deltaY: number, deltaMode: number): GestureIntent[] {
    const pixels = deltaY * (WHEEL_DELTA_SCALE[deltaMode] ?? 1);
    return [{ kind: "zoom", factor: Math.exp(pixels * WHEEL_ZOOM_RATE) }];
  }

  /** Forgets every pointer, for a canvas let go mid-gesture. */
  reset(): void {
    this.#pointers.clear();
    this.#dragging = undefined;
    this.#pinch = undefined;
  }
}
