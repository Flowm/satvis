<template>
  <!-- Held at zero opacity until the camera has flown in. -->
  <div v-if="visible" class="sky-hud" :class="{ 'sky-hud--settled': settled }">
    <svg class="sky-hud__svg">
      <path v-if="trace" class="sky-hud__trace" :d="trace" />

      <!-- Each tick's x is projected, not derived from the heading. -->
      <g class="sky-hud__tape">
        <line :x1="0" :y1="COMPASS_Y + TAPE_LENGTH" :x2="'100%'" :y2="COMPASS_Y + TAPE_LENGTH" class="sky-hud__tape-rule" />
        <g v-for="tick in compass" :key="`az${tick.value}`">
          <line :x1="tick.offset" :y1="COMPASS_Y + (tick.major ? 0 : TAPE_LENGTH / 2)" :x2="tick.offset" :y2="COMPASS_Y + TAPE_LENGTH" :class="tickClass(tick)" />
          <text v-if="tick.label" :x="tick.offset" :y="COMPASS_Y - 4" class="sky-hud__label" text-anchor="middle">{{ tick.label }}</text>
        </g>
      </g>
    </svg>

    <!-- Elevation tape, projected along the current azimuth. A separate svg so it can be
         pinned right, clear of the left-anchored menus: the svgs have no viewBox, so x is absolute. -->
    <svg class="sky-hud__svg sky-hud__side">
      <g class="sky-hud__tape">
        <line :x1="ELEVATION_RULE_X" :y1="0" :x2="ELEVATION_RULE_X" :y2="'100%'" class="sky-hud__tape-rule" />
        <g v-for="tick in elevation" :key="`el${tick.value}`">
          <line :x1="ELEVATION_RULE_X" :y1="tick.offset" :x2="ELEVATION_RULE_X + (tick.major ? TAPE_LENGTH : TAPE_LENGTH / 2)" :y2="tick.offset" :class="tickClass(tick)" />
          <text v-if="tick.major" :x="ELEVATION_RULE_X - 5" :y="tick.offset + 4" class="sky-hud__label" text-anchor="end">{{ tick.label }}</text>
        </g>
      </g>
    </svg>

    <!-- A positioned element, not a polygon: without a viewBox, centring in the svg needs the viewport width. -->
    <div class="sky-hud__pointer"></div>

    <div class="sky-hud__reticle" :class="{ 'sky-hud__reticle--locked': locked }">
      <svg viewBox="-30 -30 60 60" class="h-full w-full">
        <circle r="10" />
        <line x1="-26" y1="0" x2="-14" y2="0" />
        <line x1="14" y1="0" x2="26" y2="0" />
        <line x1="0" y1="-26" x2="0" y2="-14" />
        <line x1="0" y1="14" x2="0" y2="26" />
      </svg>
    </div>

    <!-- North is unknown until the phone has been flat once. Unlike the toast, this cannot be dismissed. -->
    <div v-if="compassActive && !calibrated" class="sky-hud__warn">Hold the phone flat to set north</div>

    <div v-if="locked" class="sky-hud__card">
      <div class="sky-hud__name">{{ locked.name }}</div>
      <dl class="sky-hud__facts">
        <template v-for="fact in facts" :key="fact[0]">
          <dt>{{ fact[0] }}</dt>
          <dd>{{ fact[1] }}</dd>
        </template>
      </dl>
      <div class="sky-hud__hint">Tap to open</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onUnmounted, watch } from "vue";

import { useController } from "../composables/useController";
import { useSkyCompass } from "../composables/useSkyCompass";
import { useSkyHud, type TapeTick } from "../composables/useSkyHud";
import { SKY_MODE } from "../config/viewModes";
import { compassPoint } from "../modules/SkyTargets";
import type { Visibility } from "../modules/util/visibility";
import { useCesiumStore } from "../stores/cesium";

/**
 * Not Tailwind: it emits no CSS for a class built at runtime.
 * The toolbar buttons occupy y 5-37, and the tick labels sit 4 px above COMPASS_Y.
 */
const COMPASS_Y = 62;
/** From the left edge of the right-pinned side svg. */
const ELEVATION_RULE_X = 46;
const TAPE_LENGTH = 12;

const cc = useController();
const { compass, elevation, locked, trace, calibrated, settled, start, stop } = useSkyHud(cc);
const { active: compassActive } = useSkyCompass(cc);

const { sceneMode } = storeToRefs(useCesiumStore());
const visible = computed(() => sceneMode.value === SKY_MODE);

const VISIBILITY_LABEL: Record<Visibility, string> = {
  visible: "Could be seen",
  shadow: "In Earth's shadow",
  daylight: "Daylight",
  far: "Too far",
};

const facts = computed<[string, string][]>(() => {
  const target = locked.value;
  if (!target) {
    return [];
  }
  return [
    ["Azimuth", `${target.azimuth.toFixed(1)}° ${compassPoint(target.azimuth)}`],
    ["Elevation", `${target.elevation.toFixed(1)}°`],
    ["Range", `${Math.round(target.rangeKm).toLocaleString()} km`],
    ["Altitude", `${Math.round(target.altitudeKm).toLocaleString()} km`],
    ["Visibility", VISIBILITY_LABEL[target.visibility]],
  ];
});

const tickClass = (tick: TapeTick): string => (tick.major ? "sky-hud__tick sky-hud__tick--major" : "sky-hud__tick");

watch(
  visible,
  (on) => {
    if (on) {
      start();
      return;
    }
    stop();
    // Also drops the sensor subscription; the compass control learns of it on its own.
    cc.skyInteraction.disableDeviceOrientation();
  },
  { immediate: true },
);
onUnmounted(() => {
  stop();
  cc.skyInteraction.disableDeviceOrientation();
});
</script>

<style scoped>
/* No pointer events: #app isolates its stacking context, so nothing here can rise above
   Cesium's credits. Look-around listens on the Cesium canvas instead. */
.sky-hud {
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
  color: #edffff;
  font-variant-numeric: tabular-nums;
  opacity: 0;
  transition: opacity 400ms ease-out;
}

.sky-hud--settled {
  opacity: 1;
}

/* The flight is a cut under reduced motion, so the overlay must not fade either. */
@media (prefers-reduced-motion: reduce) {
  .sky-hud {
    transition: none;
  }
}

.sky-hud__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

/* Full height and top-aligned, so a tick's projected window y is its y here. */
.sky-hud__side {
  inset: 0 var(--safe-right, 0px) 0 auto;
  width: 64px;
}

.sky-hud__trace {
  fill: none;
  stroke: #7dd3fc;
  stroke-width: 1.5;
  stroke-dasharray: 5 4;
  opacity: 0.85;
}

.sky-hud__tape-rule {
  stroke: #edffff;
  stroke-width: 1;
  opacity: 0.25;
}

.sky-hud__tick {
  stroke: #edffff;
  stroke-width: 1;
  opacity: 0.5;
}

.sky-hud__tick--major {
  stroke-width: 1.5;
  opacity: 0.9;
}

.sky-hud__label {
  fill: #edffff;
  font-size: 11px;
  opacity: 0.9;
  paint-order: stroke;
  stroke: #000;
  stroke-width: 2.5px;
}

/* `top` must equal COMPASS_Y + TAPE_LENGTH. */
.sky-hud__pointer {
  position: absolute;
  top: 74px;
  left: 50%;
  width: 0;
  height: 0;
  transform: translateX(-50%);
  border-left: 7px solid transparent;
  border-right: 7px solid transparent;
  border-bottom: 9px solid #4ade80;
}

.sky-hud__reticle {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 60px;
  height: 60px;
  transform: translate(-50%, -50%);
}

.sky-hud__reticle :deep(circle),
.sky-hud__reticle :deep(line) {
  fill: none;
  stroke: #edffff;
  stroke-width: 2;
  opacity: 0.55;
}

.sky-hud__reticle--locked :deep(circle),
.sky-hud__reticle--locked :deep(line) {
  stroke: #4ade80;
  opacity: 1;
}

.sky-hud__warn {
  position: absolute;
  right: calc(8px + var(--safe-right, 0px));
  /* Clears the clock deck (`--clock-deck-height`, which includes the home indicator). */
  bottom: max(calc(64px + var(--safe-bottom, 0px)), calc(var(--clock-deck-height, 0px) + 8px));
  max-width: 200px;
  padding: 6px 8px;
  border-radius: 8px;
  background-color: #303336d9;
  font-size: 12px;
  text-align: right;
}

.sky-hud__card {
  position: absolute;
  left: 50%;
  bottom: max(calc(64px + var(--safe-bottom, 0px)), calc(var(--clock-deck-height, 0px) + 8px));
  transform: translateX(-50%);
  min-width: 220px;
  padding: 8px 12px;
  border-radius: 8px;
  background-color: #303336d9;
  font-size: 13px;
  text-align: center;
}

.sky-hud__name {
  font-weight: 600;
  margin-bottom: 4px;
}

.sky-hud__facts {
  display: grid;
  grid-template-columns: auto auto;
  gap: 1px 12px;
  text-align: left;
}

.sky-hud__facts dd {
  text-align: right;
}

.sky-hud__hint {
  margin-top: 4px;
  opacity: 0.7;
  font-size: 11px;
}
</style>
