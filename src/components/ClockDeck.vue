<!-- Replaces Cesium's animation and timeline widgets. See CONTEXT.md: clock deck, scale row, rung.
     The scale row shows the timeline or the ladder, never both, so the deck height stays fixed. -->
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
        <!-- Roving tabindex: focusing a rung scrolls it into view, which sets the speed. -->
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
        <!-- A group, not a `slider`: the scale is unbounded, and a slider must declare bounds. -->
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

// The timeline moves under a fixed needle, so marks are recomputed relative to `now`.
const { passes } = usePassHighlights();
const marks = computed(() => passMarks(passes.value, now.value.getTime(), timelineWidth.value));

const ladder = ref<HTMLElement>();
const { onScroll: onLadderScroll, onDown: onLadderDown, onMove: onLadderMove, onUp: onLadderUp, pick: pickRung, showRung, step } = useLadder(clock, ladder);

const scale = ref<Scale>(Scale.Timeline);
const onLadder = computed(() => scale.value === Scale.Ladder);
// Folded on every touch device, tablets included.
const open = ref(!DeviceDetect.hasTouch());

const resettable = computed(() => (onLadder.value ? multiplier.value !== 1 : offPresent.value));

function reset(): void {
  if (onLadder.value) {
    // Through the ladder, or the shown rung and the rate in force disagree.
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
    // Reopen on the timeline, not the ladder.
    scale.value = Scale.Timeline;
  }
  chrome.setFolded(!open.value);
  if (!open.value) {
    return;
  }
  void nextTick(measure);
}

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

// Measured, not derived: the reset button appears for several reasons, and a `watch` list would drift.
// Set on the deck, not the cluster, because the scale row's fillets use them too.
const cluster = ref<HTMLElement>();
const surfaceLeft = ref(0);
const surfaceRight = ref(0);
const surfaceStyle = computed(() => ({ "--surface-left": `${surfaceLeft.value}px`, "--surface-right": `${surfaceRight.value}px` }));

const SURFACE_PAD = 8;
// `.play__circle`, not `.play`: the button box has 5 px of transparent slack on each side.
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

// The observer catches content changes; the resize listener catches viewport changes,
// including in a background tab, where observer callbacks do not run.
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
  /* Above the sky HUD (z-4) and the entity info panel (z-5), level with the toolbars. */
  z-index: 6;
  /* The full-width deck would cover Cesium's credits, which sit in another stacking
     root that no z-index reaches. The controls opt back in. */
  pointer-events: none;
  --safe: max(6px, var(--safe-bottom, 0px));
  /* Shared by the clock's corners, the scale row's, and the fillets between them. */
  --radius: 16px;
  color: #edffff;
  font-variant-numeric: tabular-nums;
  /* main.css sets the cap, and places the credits at the same breakpoint. */
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
  /* A bare `1fr` does not shrink below its content, and the heavier right side would push the clock off the needle. */
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  /* In landscape the notch is beside this row. */
  padding: 2px calc(8px + var(--safe-right, 0px)) 0 calc(8px + var(--safe-left, 0px));
}

/* Covers the controls, not the row; insets from `measureSurface`. The shadow goes up only,
   or it draws the join with the scale row. */
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

.deck--folded .cluster::before {
  border-radius: var(--radius);
  box-shadow: 0 4px 20px #000000a6;
}

.cluster > * {
  pointer-events: auto;
}

/* Below 370 px the grid does not fit, so the group centres as a whole and the clock leaves the needle. */
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
  /* A shrinking circle becomes an ellipse. */
  flex: none;
  height: 44px;
  width: 44px;
  justify-self: end;
  color: #14181c;
  font-size: 17px;
}

/* A 34 px disc in the 44 px touch target. */
.play__circle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 34px;
  width: 34px;
  border-radius: 50%;
  background: #edffff;
}

/* Fixed width: the side tracks derive from it. */
.stamp {
  position: relative;
  /* Placed, not auto-flowed: the play button goes when folded. */
  grid-column: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Held here, not by the play button, or the clock drops as the deck folds. */
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

/* Placed against the 84 px column, not the digits, so it stays inside the measured surface. */
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

/* Not just empty: under the flex fallback an empty item still takes its gap. */
.deck--folded .right {
  display: none;
}

/* A 30 px disc in a 44 px tall touch target. */
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

/* Amber: the app colour for "away from rest". */
.reset__circle {
  background: #ffd4791f;
  color: #ffd479;
}

/* The safe area is inside the height, or a strip of globe shows below the ticks. */
.scale-row {
  position: relative;
  pointer-events: auto;
  height: calc(42px + var(--safe));
  padding-bottom: var(--safe);
  border-radius: var(--radius) var(--radius) 0 0;
  background: #14181ceb;
}

/* Fillets where the clock's surface meets the row. They sit above the row, so the row
   must not clip. The half-pixel stops anti-alias the curve. */
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
  /* Or a pass band at the edge squares off the row's corners. */
  border-radius: var(--radius) var(--radius) 0 0;
  touch-action: none;
  cursor: ew-resize;
}

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
  align-items: center;
  height: 100%;
  overflow-x: auto;
  scrollbar-width: none;
  /* Lets the end rungs reach the middle. The half is passed in, because
     `calc(50% - var(--rung-width) / 2)` resolved to nothing. */
  padding-inline: calc(50% - var(--rung-inset));
  /* Dragged, not scrolled; see useClockScales. No `scroll-snap-type`: mandatory snapping
     re-snaps every programmatic write, so the ladder notches under the finger. */
  touch-action: none;
  cursor: ew-resize;
  mask-image: linear-gradient(to right, transparent, #000 24px, #000 calc(100% - 24px), transparent);
}

.ladder::-webkit-scrollbar {
  display: none;
}

.rung {
  /* Must equal `CHIP_PX`, which the scroll maths uses. */
  flex: 0 0 var(--rung-width);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  line-height: 1.2;
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

.rung--on {
  opacity: 1;
}
</style>
