<!-- Pause, playback speed and scrubbing, in place of Cesium's animation and timeline
     widgets. See CONTEXT.md: clock deck, scale row, rung.

     A control row over a scale row, and the scale row is the timeline or the ladder,
     never both — which is what keeps the deck's height fixed and the clock still.
     Tapping the clock folds the deck to the clock alone: the controls go with the
     scale row, or they hang off one side of it. -->
<template>
  <div class="deck" :class="{ 'deck--folded': !open }" :style="surfaceStyle">
    <div ref="cluster" class="cluster">
      <button v-if="open" type="button" class="play" :aria-label="playing ? 'Pause' : 'Play'" @click="togglePlaying">
        <span class="play__circle">
          <UIcon :name="playing ? 'lucide:pause' : 'lucide:play'" />
        </span>
      </button>

      <button type="button" class="stamp" :aria-label="`${clockLabel(now)}, ${open ? 'Hide' : 'Show'} clock controls`" :aria-expanded="open" @click="toggle">
        <span class="stamp__time">{{ clockLabel(now) }}</span>
        <span class="stamp__date">{{ dateLabel(now) }} UTC</span>
        <span v-if="!offPresent" class="stamp__live" role="img" aria-label="Live"></span>
      </button>

      <div class="right">
        <template v-if="open">
          <!-- Before the reset, so it holds still as the reset comes and goes. -->
          <button type="button" class="mode" :aria-pressed="onLadder" :aria-label="onLadder ? 'Show timeline' : 'Set playback speed'" @click="toggleScale">
            <span class="mode__circle" :class="{ 'mode__circle--on': onLadder }">
              <UIcon :name="onLadder ? 'lucide:clock' : 'lucide:gauge'" />
            </span>
          </button>

          <button v-if="resettable" type="button" class="reset" :aria-label="onLadder ? 'Back to real time' : 'Back to now'" @click="reset">
            <span class="reset__circle">
              <UIcon name="lucide:rotate-ccw" />
            </span>
          </button>
        </template>
      </div>
    </div>

    <!-- Height fixed here, not by the scale inside it, so switching moves nothing. -->
    <div v-if="open" class="scale-row">
      <template v-if="onLadder">
        <!-- Roving tabindex: focusing a rung scrolls it into view, and that sets the
             speed, so 36 tab stops would drag the clock across the whole ladder. -->
        <div
          ref="ladder"
          class="ladder"
          :style="{ '--rung-width': `${CHIP_PX}px`, '--rung-inset': `${CHIP_PX / 2}px` }"
          role="radiogroup"
          aria-label="Playback speed"
          @scroll="onLadderScroll"
          @keydown="onLadderKey"
          @pointerdown="onLadderDown"
          @pointermove="onLadderMove"
          @pointerup="onLadderUp"
          @pointercancel="onLadderUp"
        >
          <button
            v-for="(value, index) in LADDER"
            :key="value"
            type="button"
            role="radio"
            class="rung"
            :class="{ 'rung--on': index === rung }"
            :aria-checked="index === rung"
            :tabindex="index === rung ? 0 : -1"
            @click="pickRung(index)"
          >
            <span class="rung__mult">{{ multiplierLabel(value) }}</span>
            <span class="rung__rate">{{ rateLabel(value) }}</span>
          </button>
        </div>
      </template>

      <template v-else>
        <!-- A group, not a `slider`: a slider must say what its bounds are, and a
             relative drag on an unbounded scale has none. -->
        <div
          ref="timeline"
          class="timeline"
          role="group"
          tabindex="0"
          aria-label="Timeline"
          @pointerdown="onTimelineDown"
          @pointermove="onTimelineMove"
          @pointerup="onTimelineUp"
          @pointercancel="onTimelineUp"
          @keydown="onTimelineKey"
        >
          <!-- Before the ticks, so the scale stays readable across a mark. -->
          <div v-for="mark in marks" :key="mark.key" class="pass" :style="{ left: `${mark.left}px`, width: `${mark.width}px` }"></div>
          <div v-for="tick in ticks" :key="tick.at" class="tick" :class="{ 'tick--major': tick.major }" :style="{ left: `${tick.x}px` }">
            <span v-if="tick.label" class="tick__label">{{ tick.label }}</span>
          </div>
        </div>
        <!-- Timeline only: over the ladder it strikes through the selected multiplier. -->
        <div class="needle"></div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import { useClockDeckChrome } from "../composables/useClockDeckChrome";
import { useLadder, useTimeline } from "../composables/useClockScales";
import { usePassHighlights } from "../composables/usePassHighlights";
import { useViewerClock } from "../composables/useViewerClock";
import { arrowStep, Scale, CHIP_PX, clockLabel, dateLabel, LADDER, multiplierLabel, passMarks, rateLabel, REAL_TIME_RUNG } from "../modules/util/clockDeck";
import { DeviceDetect } from "../modules/util/DeviceDetect";

const clock = useViewerClock();
const { now, playing, multiplier, rung, offPresent, togglePlaying, goLive } = clock;

const timeline = ref<HTMLElement>();
const { ticks, width: timelineWidth, onDown: onTimelineDown, onMove: onTimelineMove, onUp: onTimelineUp, onKey: onTimelineKey, measure } = useTimeline(clock, timeline);

// Marks, not ranges: the timeline moves under a fixed needle, so a pass only has a
// position relative to this frame.
const { passes } = usePassHighlights();
const marks = computed(() => passMarks(passes.value, now.value.getTime(), timelineWidth.value));

const ladder = ref<HTMLElement>();
const { onScroll: onLadderScroll, onDown: onLadderDown, onMove: onLadderMove, onUp: onLadderUp, pick: pickRung, showRung, step } = useLadder(clock, ladder);

// The timeline by default: it is what the deck is for.
const scale = ref<Scale>(Scale.Timeline);
const onLadder = computed(() => scale.value === Scale.Ladder);
// Folded wherever the pointer is coarse — a tablet as much as a phone, which is the
// intent: the clock alone is what most touch sessions need. Open under a mouse.
const open = ref(!DeviceDetect.hasTouch());

/** Whether the scale showing is away from where it rests. */
const resettable = computed(() => (onLadder.value ? multiplier.value !== 1 : offPresent.value));

/** Undo the deviation on whichever scale is showing. */
function reset(): void {
  if (onLadder.value) {
    // Through the ladder, or the rung it rests on and the rate in force disagree.
    showRung(REAL_TIME_RUNG, { animate: true });
    return;
  }
  goLive();
}

function toggleScale(): void {
  scale.value = onLadder.value ? Scale.Timeline : Scale.Ladder;
  // Each scale is `v-if`d, so the arriving one has no width until it is in the tree.
  void nextTick(() => {
    if (onLadder.value) {
      showRung(rung.value, { animate: false });
      return;
    }
    measure();
  });
}

function toggle(): void {
  open.value = !open.value;
  if (!open.value) {
    // Coming back to the ladder is coming back to the wrong instrument.
    scale.value = Scale.Timeline;
  }
  chrome.setFolded(!open.value);
  if (!open.value) {
    return;
  }
  void nextTick(measure);
}

/** Arrow keys walk the ladder, and take focus with them. */
function onLadderKey(event: KeyboardEvent): void {
  const direction = arrowStep(event.key);
  if (direction === 0) {
    return;
  }
  event.preventDefault();
  step(direction, rung.value);
  // After the re-render, the newly selected rung is the one holding tabindex 0.
  void nextTick(() => ladder.value?.querySelector<HTMLElement>(".rung--on")?.focus());
}

// The surface's insets from the row's edges. Measured, not derived: the reset comes
// and goes for three reasons, so a `watch` over them is a list that will be wrong.
// Set on the deck, not the cluster: the scale row's fillets are placed off them too.
const cluster = ref<HTMLElement>();
const surfaceLeft = ref(0);
const surfaceRight = ref(0);
const surfaceStyle = computed(() => ({ "--surface-left": `${surfaceLeft.value}px`, "--surface-right": `${surfaceRight.value}px` }));

const SURFACE_PAD = 8;
// `.play__circle` and not `.play`: the button's box carries 5 px of transparent
// slack on each side of the circle, which would land as 13 px of padding on the left
// against 8 on the right.
const SURFACE_PARTS = ".play__circle, .stamp, .mode, .reset";

function measureSurface(): void {
  const row = cluster.value;
  if (!row) {
    return;
  }
  const box = row.getBoundingClientRect();
  const parts = [...row.querySelectorAll(SURFACE_PARTS)].map((part) => part.getBoundingClientRect());
  if (parts.length === 0) {
    return;
  }
  const left = Math.min(...parts.map((part) => part.left)) - SURFACE_PAD;
  const right = Math.max(...parts.map((part) => part.right)) + SURFACE_PAD;
  // Clamped, so the padding cannot push the surface off screen.
  surfaceLeft.value = Math.max(0, left - box.left);
  surfaceRight.value = Math.max(0, box.right - right);
}

// The observer answers the row's contents changing, between layout and paint. The
// listener answers the viewport changing, and covers the backgrounded tab where the
// observer's callbacks do not run.
let rowSize: ResizeObserver | undefined;
const onResize = (): void => measureSurface();

const chrome = useClockDeckChrome();

watch(open, () => void nextTick(measureSurface));

onMounted(() => {
  measure();
  measureSurface();
  chrome.attach(!open.value);
  window.addEventListener("resize", onResize);
  const group = cluster.value?.querySelector(".right");
  if (cluster.value && group) {
    rowSize = new ResizeObserver(measureSurface);
    rowSize.observe(cluster.value);
    rowSize.observe(group);
  }
});

onUnmounted(() => {
  window.removeEventListener("resize", onResize);
  rowSize?.disconnect();
});
</script>

<style scoped>
.deck {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* Above the sky view's HUD (z-4) and the entity info panel (z-5), and level with
     the toolbars (z-6): the clock is chrome, not content. */
  z-index: 6;
  /* The deck is a box the width of the screen, and it would cover whatever shares
     its rows — Cesium's credit line sits in them at some widths and under them
     when this is folded. Lifting the credits instead is not possible: they are in
     Cesium's own stacking root and this is in the app's, so no z-index reaches
     across. The deck therefore hits nothing, and the things that are controls opt
     back in. */
  pointer-events: none;
  --safe: max(6px, var(--safe-bottom, 0px));
  /* Shared by the clock's corners, the scale row's, and the fillets between them. */
  --radius: 16px;
  color: #edffff;
  font-variant-numeric: tabular-nums;
  /* A phone's width, centred, on anything wider. main.css sets the cap and places
     the credit line at the same breakpoint. */
  margin: 0 auto;
  max-width: var(--clock-deck-max, 100%);
}

/* The scale row's height is held when it goes, or the clock drops onto the credits. */
.deck--folded {
  padding-bottom: calc(42px + var(--safe));
}

.cluster {
  position: relative;
  /* Or `::before` falls behind the deck too. */
  isolation: isolate;
  display: grid;
  /* `minmax(0, 1fr)`: a bare `1fr` will not shrink below its content, and the heavier
     right side would push the clock off the needle. */
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  /* Sideways the notch is beside this row, not above it. */
  padding: 2px calc(8px + var(--safe-right, 0px)) 0 calc(8px + var(--safe-left, 0px));
}

/* Covers the controls, not the row: two thirds of the row is empty. Insets from
   `measureSurface`; flush along the bottom, and the shadow goes up only, or it draws
   the join with the scale row. */
.cluster::before {
  content: "";
  position: absolute;
  left: var(--surface-left, 0);
  right: var(--surface-right, 0);
  top: 0;
  bottom: 0;
  z-index: -1;
  border-radius: var(--radius) var(--radius) 0 0;
  background: #14181ceb;
  box-shadow: 0 -2px 20px #00000080;
}

/* Nothing below it, so it closes into a card. */
.deck--folded .cluster::before {
  border-radius: var(--radius);
  box-shadow: 0 4px 20px #000000a6;
}

/* Only the controls, not the row. See the deck. */
.cluster > * {
  pointer-events: auto;
}

/* Below 370 px nothing both centres the clock and fits, so the group centres as a
   whole and the clock leaves the needle. */
@media (max-width: 369px) {
  .cluster {
    display: flex;
    justify-content: center;
  }

  .right {
    justify-self: auto;
  }
}

.play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* A circle that shrinks is an ellipse, and a row too wide for its viewport takes
     it out of the roundest thing in it. */
  flex: none;
  height: 44px;
  width: 44px;
  justify-self: end;
  color: #14181c;
  font-size: 17px;
}

/* 34, not 44: a disc that size beside 30 px ones reads as another kind of object.
   The box stays 44 for the touch target. */
.play__circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 34px;
  width: 34px;
  border-radius: 50%;
  background: #edffff;
}

/* Fixed: the side tracks derive from it, so a clock that changed width would move its neighbours. */
.stamp {
  position: relative;
  /* Placed, not auto-flowed: the play button goes when folded, and the clock would
     take the column it left. */
  grid-column: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Held here, not by the play button, which goes when folded: or the clock drops as
     the deck closes. */
  min-height: 44px;
  width: 84px;
  line-height: 1.15;
  white-space: nowrap;
  text-align: center;
}

.stamp__time {
  font-size: 20px;
  font-weight: 600;
}

.stamp__date {
  font-size: 11px;
  opacity: 0.55;
}

/* At the present, as a dot: a chip saying so cost 44 px of a 137 px track. Placed
   against the 84 px column and not the 82 px of digits, so it stays inside the
   surface, which is measured to the column's edge plus 8. */
.stamp__live {
  position: absolute;
  top: 0;
  right: -3px;
  height: 6px;
  width: 6px;
  border-radius: 50%;
  background: #7ee787;
  box-shadow: 0 0 6px #7ee78766;
}

.right {
  grid-column: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  justify-self: start;
  min-width: 0;
}

/* Gone, not just empty: under the flex fallback an empty item still takes its gap,
   and that pushes the clock off centre. */
.deck--folded .right {
  display: none;
}

/* A 30 px disc in a 44 px box: chip-sized to look at, thumb-sized to hit. */
.mode,
.reset {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  height: 44px;
  width: 34px;
}

.mode__circle,
.reset__circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  width: 30px;
  border-radius: 50%;
  background: #ffffff14;
  font-size: 15px;
}

.mode__circle--on {
  background: #ffffff2e;
}

/* Amber: the app's colour for "not where it rests". */
.reset__circle {
  background: #ffd4791f;
  color: #ffd479;
}

/* The ticks are hairlines over the globe and need a surface. The safe area is inside
   its height, not under it, or a strip of globe shows below the ticks. */
.scale-row {
  position: relative;
  pointer-events: auto;
  height: calc(42px + var(--safe));
  padding-bottom: var(--safe);
  border-radius: var(--radius) var(--radius) 0 0;
  background: #14181ceb;
}

/* Fillets where the clock's surface meets the row, so the two read as one shape.
   Each is a square filled outside a quarter circle. They sit above the row, so the
   row must not clip. The half-pixel stops anti-alias the curve. */
.scale-row::before,
.scale-row::after {
  content: "";
  position: absolute;
  top: calc(-1 * var(--radius));
  height: var(--radius);
  width: var(--radius);
  pointer-events: none;
}

.scale-row::before {
  left: calc(var(--surface-left, 0px) - var(--radius));
  background: radial-gradient(circle at 0 0, transparent calc(var(--radius) - 0.5px), #14181ceb calc(var(--radius) + 0.5px));
}

.scale-row::after {
  right: calc(var(--surface-right, 0px) - var(--radius));
  background: radial-gradient(circle at 100% 0, transparent calc(var(--radius) - 0.5px), #14181ceb calc(var(--radius) + 0.5px));
}

.timeline {
  position: relative;
  height: 100%;
  overflow: hidden;
  /* The row's corners again: a pass band reaching the edge would square them off. */
  border-radius: var(--radius) var(--radius) 0 0;
  /* The whole surface is the control; the browser must not take the gesture. */
  touch-action: none;
  cursor: ew-resize;
}

/* The passes table's blue, at a weight that reads as a region and not a control. */
.pass {
  position: absolute;
  top: 0;
  bottom: 0;
  background: #56b4e926;
  border-left: 1px solid #56b4e966;
  border-right: 1px solid #56b4e966;
  pointer-events: none;
}

.tick {
  position: absolute;
  bottom: 0;
  width: 1px;
  height: 9px;
  background: #ffffff40;
}

.tick--major {
  height: 17px;
  background: #ffffff8c;
}

.tick__label {
  position: absolute;
  bottom: 19px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 10px;
  white-space: nowrap;
  opacity: 0.6;
}

.needle {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: #ffd479;
  pointer-events: none;
}

.ladder {
  display: flex;
  /* The row's height, not its own, so swapping the scales moves nothing. */
  align-items: center;
  height: 100%;
  overflow-x: auto;
  scrollbar-width: none;
  /* Half a rung either side, so the first and last rung can reach the middle. Both
     widths come from `CHIP_PX`: the half is passed in rather than divided here,
     because `calc(50% - var(--rung-width) / 2)` resolved to nothing and cost the
     the ladder its padding, which put every rung half a rung off the needle. */
  padding-inline: calc(50% - var(--rung-inset));
  /* Dragged, not scrolled — see useClockScales. `scroll-snap-type` is deliberately
     absent: mandatory snapping re-snaps every programmatic write, so the ladder
     notches under the finger instead of following it. */
  touch-action: none;
  cursor: ew-resize;
  /* Rungs clipped mid-glyph at both ends read as damage rather than as more ladder. */
  mask-image: linear-gradient(to right, transparent, #000 24px, #000 calc(100% - 24px), transparent);
}

.ladder::-webkit-scrollbar {
  display: none;
}

/* Multipliers lead because `300× 600× 900×` reads as a scale where `5 min/s
   10 min/s` is ragged; the rate underneath says why you would pick one. */
.rung {
  /* `CHIP_PX`, which is also the scroll maths: a rung of another width selects the
     wrong one. */
  flex: 0 0 var(--rung-width);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  line-height: 1.2;
  /* Dimmed but readable: that is how you know what picking it would do. */
  opacity: 0.55;
}

.rung__mult {
  font-size: 15px;
  font-weight: 600;
}

.rung__rate {
  font-size: 10px;
  opacity: 0.75;
}

/* Brightness alone carries the selection. Not amber: that is the needle and the reset. */
.rung--on {
  opacity: 1;
}
</style>
