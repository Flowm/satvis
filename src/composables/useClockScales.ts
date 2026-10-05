// The scale row's two instruments as gestures: a timeline dragged past a fixed
// needle, and a ladder of speeds swiped under the same middle. One drag model for both.

import { computed, onUnmounted, ref, type Ref } from "vue";

import {
  arrowStep,
  CHIP_PX,
  clampMagnitude,
  decayVelocity,
  MAX_SCRUB_VELOCITY,
  MAX_SWIPE_VELOCITY,
  MIN_SWIPE_VELOCITY,
  MS_PER_PX,
  nearestRung,
  timelineTicks,
  LADDER,
} from "../modules/util/clockDeck";
import { DeviceDetect } from "../modules/util/DeviceDetect";
import type { ViewerClock } from "./useViewerClock";

const scrollBehavior = (): ScrollBehavior => (DeviceDetect.prefersReducedMotion() ? "auto" : "smooth");

/**
 * Move with the finger, coast on release, then settle. Velocities are the caller's units
 * per real ms. `advance` returns false when the move did not land, which ends the coast.
 */
function useFlickDrag(options: {
  unitsPerPixel: number;
  maxVelocity: number;
  minVelocity: number;
  onStart?: () => void;
  advance: (delta: number) => boolean;
  onSettle: (moved: boolean) => void;
}) {
  let dragging = false;
  // A press that never moved is not a gesture: the timeline must not pin, and the ladder
  // must let the rung's own tap through.
  let moved = false;
  let lastX = 0;
  let lastAt = 0;
  let velocity = 0;
  let frame = 0;
  let coasting = false;

  function onDown(event: PointerEvent): void {
    cancelAnimationFrame(frame);
    coasting = false;
    dragging = true;
    moved = false;
    velocity = 0;
    lastX = event.clientX;
    lastAt = event.timeStamp;
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    options.onStart?.();
  }

  function onMove(event: PointerEvent): void {
    if (!dragging) {
      return;
    }
    const dx = event.clientX - lastX;
    if (dx === 0) {
      return;
    }
    moved = true;
    // Floored at 1 ms and clamped: two events in one millisecond would give an absurd speed.
    const dt = Math.max(1, event.timeStamp - lastAt);
    lastX = event.clientX;
    lastAt = event.timeStamp;
    const delta = -dx * options.unitsPerPixel;
    velocity = clampMagnitude(delta / dt, options.maxVelocity);
    options.advance(delta);
  }

  function onUp(): void {
    if (!dragging) {
      return;
    }
    dragging = false;
    // A coast would wait on a frame that never comes in a hidden tab.
    if (!moved || DeviceDetect.prefersReducedMotion() || Math.abs(velocity) < options.minVelocity) {
      options.onSettle(moved);
      return;
    }
    coasting = true;
    glide(performance.now());
  }

  function glide(previous: number): void {
    frame = requestAnimationFrame((at) => {
      const dt = at - previous;
      const advanced = options.advance(velocity * dt);
      velocity = decayVelocity(velocity, dt);
      if (advanced && Math.abs(velocity) > options.minVelocity) {
        glide(at);
        return;
      }
      coasting = false;
      options.onSettle(true);
    });
  }

  const stop = (): void => cancelAnimationFrame(frame);

  return { onDown, onMove, onUp, stop, dragging: () => dragging, gliding: () => coasting, moved: () => moved };
}

export function useTimeline(clock: ViewerClock, timeline: Ref<HTMLElement | undefined>) {
  const width = ref(360);
  const ticks = computed(() => timelineTicks(clock.now.value.getTime(), width.value));

  // Sim ms per real ms; the floor is a coast moving the clock by under a ms a frame.
  const drag = useFlickDrag({
    unitsPerPixel: MS_PER_PX,
    maxVelocity: MAX_SCRUB_VELOCITY,
    minVelocity: 1 / MS_PER_PX,
    onStart: () => clock.beginScrub(),
    advance: (delta) => {
      clock.scrubTo(new Date(clock.now.value.getTime() + delta));
      return true;
    },
    // `endScrub` writes the store, so a stray tap would pin the clock.
    onSettle: (moved) => (moved ? clock.endScrub() : clock.cancelScrub()),
  });

  /** The only path without a pointer. */
  function onKey(event: KeyboardEvent): void {
    const direction = arrowStep(event.key);
    if (direction === 0) {
      return;
    }
    event.preventDefault();
    const step = (event.shiftKey ? 3_600_000 : 600_000) * direction;
    clock.beginScrub();
    clock.scrubTo(new Date(clock.now.value.getTime() + step));
    clock.endScrub();
  }

  const measure = (): void => {
    width.value = timeline.value?.clientWidth ?? width.value;
  };

  window.addEventListener("resize", measure);
  onUnmounted(() => {
    window.removeEventListener("resize", measure);
    drag.stop();
  });

  return { ticks, width, onDown: drag.onDown, onMove: drag.onMove, onUp: drag.onUp, onKey, measure };
}

/**
 * A scroll container the finger drags directly. Native `scroll-snap-type: x mandatory`
 * is nothing at all under a mouse, and it re-snaps every programmatic write, so the
 * ladder notches against the finger; `settle` rests it on a rung instead.
 */
export function useLadder(clock: ViewerClock, ladder: Ref<HTMLElement | undefined>, chipPx: number = CHIP_PX) {
  // A programmatic scroll raises the same event a finger does.
  let settling = false;
  let settleTarget = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let rest: ReturnType<typeof setTimeout> | undefined;

  // A backstop: the window normally closes when the scroll arrives.
  const SETTLE_BACKSTOP_MS = 2000;
  // How long a wheel must stop before the ladder settles.
  const REST_MS = 120;

  function scrollToRung(at: number, behavior: ScrollBehavior): void {
    settling = true;
    settleTarget = at * chipPx;
    ladder.value?.scrollTo({ left: settleTarget, behavior });
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settling = false;
    }, SETTLE_BACKSTOP_MS);
    clock.setRung(at);
  }

  const restingRung = (): number => nearestRung(ladder.value?.scrollLeft ?? 0, chipPx);

  function onScroll(): void {
    if (!ladder.value) {
      return;
    }
    if (settling) {
      if (Math.abs(ladder.value.scrollLeft - settleTarget) < 1) {
        settling = false;
        clearTimeout(settleTimer);
      }
      return;
    }
    const value = LADDER[restingRung()]!;
    if (value !== clock.multiplier.value) {
      clock.setMultiplier(value);
    }
    // A wheel can leave it between rungs; a drag and a coast settle themselves.
    if (!drag.dragging() && !drag.gliding()) {
      clearTimeout(rest);
      rest = setTimeout(settle, REST_MS);
    }
  }

  // Scroll px per real ms. The element clamps `scrollLeft`, so an unchanged write is
  // how a coast learns it has hit an end.
  const drag = useFlickDrag({
    unitsPerPixel: 1,
    maxVelocity: MAX_SWIPE_VELOCITY,
    minVelocity: MIN_SWIPE_VELOCITY,
    onStart: () => {
      clearTimeout(settleTimer);
      clearTimeout(rest);
      settling = false;
    },
    advance: (delta) => {
      if (!ladder.value) {
        return false;
      }
      const before = ladder.value.scrollLeft;
      ladder.value.scrollLeft += delta;
      return ladder.value.scrollLeft !== before;
    },

    onSettle: (moved) => {
      if (moved) {
        settle();
      }
    },
  });

  function settle(): void {
    const rung = restingRung();
    // Animating from a rung to itself is how this loops.
    if (ladder.value && Math.abs(ladder.value.scrollLeft - rung * chipPx) < 1) {
      return;
    }
    scrollToRung(rung, scrollBehavior());
  }

  /** Ignored after a swipe: pointer capture makes the browser click the rung it went down on. */
  function pick(rung: number): void {
    if (drag.moved()) {
      return;
    }
    scrollToRung(rung, scrollBehavior());
  }

  const showRung = (rung: number, { animate }: { animate: boolean }): void => scrollToRung(rung, animate ? scrollBehavior() : "auto");

  function step(direction: number, from: number): number {
    const next = Math.min(LADDER.length - 1, Math.max(0, from + direction));
    if (next !== from) {
      scrollToRung(next, "auto");
    }
    return next;
  }

  onUnmounted(() => {
    clearTimeout(settleTimer);
    clearTimeout(rest);
    drag.stop();
  });

  return { onScroll, onDown: drag.onDown, onMove: drag.onMove, onUp: drag.onUp, pick, showRung, step };
}
