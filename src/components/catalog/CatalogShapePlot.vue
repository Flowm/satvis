<!-- Inclination by mean altitude on a canvas, as ~17,000 SVG nodes would be too many. -->
<template>
  <div class="shapePlot cs-measured">
    <div class="cs-tileHead">
      <UIcon name="lucide:scatter-chart" class="cs-mute" /> Orbit shape
      <span v-if="box" class="cs-dim cs-num"
        >{{ formatAltitude(box.altitudeKm[0]) }}–{{ formatAltitude(box.altitudeKm[1]) }} km · {{ box.inclinationDeg[0].toFixed(0) }}–{{ box.inclinationDeg[1].toFixed(0) }}°</span
      >
      <span v-else class="cs-mute cs-hint">drag a box to filter</span>
      <span class="cs-headEnd">
        <button v-if="box" type="button" class="cs-reset" @click="emit('update:box', null)">reset</button>
        <catalog-tile-toggle :open="open" label="orbit shape" @click="emit('toggle-open')" />
      </span>
    </div>
    <div v-if="open" class="shapePlot__legend">
      <span v-for="item in LEGEND" :key="item.label"><i :style="{ background: item.color }" />{{ item.label }}</span>
      <span class="cs-mute"><i class="shapePlot__faint" />outside the other filters</span>
    </div>
    <div class="shapePlot__chart" :style="{ height: `${height}px` }">
      <div class="shapePlot__yAxis cs-num">
        <span v-for="tick in altitudeTicks" :key="tick" :style="{ bottom: `${altitudeToY(tick) * 100}%` }">{{ formatAltitude(tick) }}</span>
      </div>
      <div
        ref="plotEl"
        class="shapePlot__plot"
        role="img"
        aria-label="Satellites by inclination and mean altitude"
        @pointerdown="dragStart"
        @pointermove="dragMove"
        @pointerup="dragEnd"
        @pointerleave="hover = null"
      >
        <canvas ref="canvasEl" class="shapePlot__canvas" />
        <div v-if="boxStyle" class="shapePlot__box" :style="boxStyle" />
        <span v-for="band in BANDS" :key="band.label" class="shapePlot__band" :style="{ bottom: `${altitudeToY(band.altitudeKm) * 100}%` }">{{ band.label }}</span>
        <span v-if="hover" class="shapePlot__tip cs-num" :style="{ left: `${hover.x}px`, top: `${hover.y}px` }"
          >{{ formatAltitude(hover.altitudeKm) }} km · {{ hover.inclinationDeg.toFixed(0) }}°</span
        >
      </div>
    </div>
    <div class="shapePlot__xAxis cs-num">
      <span v-for="tick in INCLINATION_TICKS" :key="tick" :style="{ left: `calc(32px + (100% - 32px) * ${tick / INCLINATION_MAX})` }">{{ tick }}°</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { ORBIT_CLASS_COLOR, orbitColor, SUN_SYNC_COLOR } from "../../config/orbitClass";
import type { CatalogRow, ShapeBox } from "../../modules/catalogFacets";
import CatalogTileToggle from "./CatalogTileToggle.vue";

const props = defineProps<{
  rows: readonly CatalogRow[];
  /** The rows passing every filter but the box: drawn bright, the rest faint for context. */
  brightRows: readonly CatalogRow[];
  box: ShapeBox | null;
  /** Px, the plot's height. */
  height: number;
  open: boolean;
}>();
const emit = defineEmits<{ "update:box": [box: ShapeBox | null]; "toggle-open": [] }>();

/** Degrees; nothing in the catalog orbits beyond ~145°, and 120 spreads the polar orbits. */
const INCLINATION_MAX = 120;
/** Degrees, the x axis ticks. */
const INCLINATION_TICKS = [0, 30, 60, 90, 120];
/** Km, the log axis's ends: below the lowest LEO, above GEO. */
const ALTITUDE_MIN = 150;
const ALTITUDE_MAX = 50_000;
/** Labels at the altitudes GNSS and GEO crowd at. */
const BANDS = [
  { label: "GNSS", altitudeKm: 20_200 },
  { label: "GEO", altitudeKm: 35_786 },
];
/** GCAT's sun-sync band: LEO between 95° and 104°. */
const SUN_SYNC = { inclinationDeg: [95, 104], altitudeKm: 2000 } as const;
/** LEO's grey is too quiet for a dot on the plot. */
const LEO_DOT = "#74c0fc";
/** The plot's colours, for its legend when opened. */
const LEGEND = [
  { label: "LEO", color: LEO_DOT },
  { label: "Sun-sync", color: SUN_SYNC_COLOR },
  { label: "MEO", color: ORBIT_CLASS_COLOR.MEO },
  { label: "GEO", color: ORBIT_CLASS_COLOR.GEO },
  { label: "HEO", color: ORBIT_CLASS_COLOR.HEO },
];

// Log altitude: the LEO shells and GEO would not share a linear axis.
const LOG_SPAN = Math.log(ALTITUDE_MAX) - Math.log(ALTITUDE_MIN);
/** 0 at the bottom of the log axis, 1 at its top. */
const altitudeToY = (km: number) => (Math.log(Math.max(km, ALTITUDE_MIN)) - Math.log(ALTITUDE_MIN)) / LOG_SPAN;
/** The inverse of altitudeToY. */
const yToAltitude = (y: number) => Math.exp(Math.log(ALTITUDE_MIN) + y * LOG_SPAN);
/** "550", "20.2k". */
const formatAltitude = (km: number) => (km >= 1000 ? `${Math.round(km / 100) / 10}k` : String(Math.round(km)));

/** A short plot labels every other altitude. */
const altitudeTicks = computed(() => (props.height < 150 ? [200, 1000, 5000, 20_000] : [200, 500, 1000, 2000, 5000, 20_000]));

// The plot area, measured so the canvas draws at its size.
const plotEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const size = ref({ width: 0, height: 0 });
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry) size.value = { width: entry.contentRect.width, height: entry.contentRect.height };
  });
  if (plotEl.value) observer.observe(plotEl.value);
});
onBeforeUnmount(() => observer?.disconnect());

/** The bright rows, for a constant-time check while drawing. */
const brightSet = computed(() => new Set(props.brightRows));

/** The class's colour, but blue for LEO's grey. */
function dotColor(row: CatalogRow): string {
  const color = orbitColor(row.orbitClass, row.orbitKind);
  return color === ORBIT_CLASS_COLOR.LEO ? LEO_DOT : color;
}

/** Redraws everything: the band, the grid, the faint rows, then the bright ones. */
function draw(): void {
  const canvas = canvasEl.value;
  const { width, height } = size.value;
  if (!canvas || width === 0 || height === 0) {
    return;
  }
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.scale(ratio, ratio);
  const x = (inclination: number) => (Math.min(inclination, INCLINATION_MAX) / INCLINATION_MAX) * width;
  const y = (altitude: number) => height - altitudeToY(altitude) * height;

  ctx.fillStyle = `${SUN_SYNC_COLOR}14`;
  ctx.fillRect(x(SUN_SYNC.inclinationDeg[0]), y(SUN_SYNC.altitudeKm), x(SUN_SYNC.inclinationDeg[1]) - x(SUN_SYNC.inclinationDeg[0]), height - y(SUN_SYNC.altitudeKm));
  ctx.strokeStyle = "#ffffff12";
  ctx.beginPath();
  for (const tick of altitudeTicks.value) {
    ctx.moveTo(0, y(tick));
    ctx.lineTo(width, y(tick));
  }
  for (const tick of INCLINATION_TICKS) {
    ctx.moveTo(x(tick), 0);
    ctx.lineTo(x(tick), height);
  }
  ctx.stroke();

  ctx.fillStyle = "#ffffff14";
  for (const row of props.rows) {
    if (!brightSet.value.has(row)) {
      ctx.fillRect(x(row.inclinationDeg) - 1, y(row.altitudeKm) - 1, 2, 2);
    }
  }
  ctx.globalAlpha = 0.75;
  for (const row of props.brightRows) {
    ctx.fillStyle = dotColor(row);
    ctx.fillRect(x(row.inclinationDeg) - 1, y(row.altitudeKm) - 1, 2.5, 2.5);
  }
  ctx.globalAlpha = 1;
}

// Not requestAnimationFrame: a hidden tab never runs it, and the plot would stay blank.
watch([size, () => props.rows, () => props.brightRows, altitudeTicks], () => setTimeout(draw), { immediate: true });

// The pointer: where it is, and the box it drags.
const hover = ref<{ x: number; y: number; altitudeKm: number; inclinationDeg: number } | null>(null);
const drag = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

/** The pointer in the plot's px, clamped to it. */
function local(event: PointerEvent): { x: number; y: number } {
  const rect = plotEl.value!.getBoundingClientRect();
  return { x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) };
}
/** Starts a box at the pointer. */
function dragStart(event: PointerEvent): void {
  plotEl.value?.setPointerCapture(event.pointerId);
  const { x, y } = local(event);
  drag.value = { x0: x, y0: y, x1: x, y1: y };
}
/** Tracks the pointer for the tooltip, and grows the box while dragging. */
function dragMove(event: PointerEvent): void {
  const { x, y } = local(event);
  const { width, height } = size.value;
  hover.value = { x, y, altitudeKm: yToAltitude(1 - y / height), inclinationDeg: (x / width) * INCLINATION_MAX };
  if (drag.value) {
    drag.value = { ...drag.value, x1: x, y1: y };
  }
}
/** A click without a drag clears the box. */
function dragEnd(): void {
  const d = drag.value;
  drag.value = null;
  if (!d) {
    return;
  }
  const { width, height } = size.value;
  if (Math.abs(d.x1 - d.x0) < 4 && Math.abs(d.y1 - d.y0) < 4) {
    emit("update:box", null);
    return;
  }
  const inclinationDeg: [number, number] = [(Math.min(d.x0, d.x1) / width) * INCLINATION_MAX, (Math.max(d.x0, d.x1) / width) * INCLINATION_MAX];
  // A box to the right edge reaches every retrograde orbit past the axis.
  if (inclinationDeg[1] >= INCLINATION_MAX - 0.5) {
    inclinationDeg[1] = 180;
  }
  emit("update:box", { altitudeKm: [yToAltitude(1 - Math.max(d.y0, d.y1) / height), yToAltitude(1 - Math.min(d.y0, d.y1) / height)], inclinationDeg });
}

/** The box being dragged, else the one picked. */
const boxStyle = computed(() => {
  const { width, height } = size.value;
  if (drag.value) {
    const d = drag.value;
    return { left: `${Math.min(d.x0, d.x1)}px`, top: `${Math.min(d.y0, d.y1)}px`, width: `${Math.abs(d.x1 - d.x0)}px`, height: `${Math.abs(d.y1 - d.y0)}px` };
  }
  if (!props.box || width === 0) {
    return null;
  }
  const { altitudeKm, inclinationDeg } = props.box;
  const x0 = (inclinationDeg[0] / INCLINATION_MAX) * width;
  const x1 = (Math.min(inclinationDeg[1], INCLINATION_MAX) / INCLINATION_MAX) * width;
  const y0 = height - altitudeToY(altitudeKm[1]) * height;
  const y1 = height - altitudeToY(altitudeKm[0]) * height;
  return { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` };
});
</script>

<style scoped>
.shapePlot__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: -2px 0 8px;
  font-size: 11px;
  color: var(--cs-dim);
}

.shapePlot__legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 5px;
  border-radius: 2px;
}

.shapePlot__legend .shapePlot__faint {
  background: #ffffff30;
}

.shapePlot__chart {
  display: flex;
  gap: 6px;
  transition: height 0.3s ease;
}

.shapePlot__yAxis {
  position: relative;
  flex: none;
  width: 26px;
  font-size: 10px;
  color: var(--cs-mute);
}

.shapePlot__yAxis span {
  position: absolute;
  right: 0;
  transform: translateY(50%);
}

.shapePlot__plot {
  position: relative;
  flex: 1;
  min-width: 0;
  border-bottom: 1px solid #ffffff40;
  border-left: 1px solid #ffffff40;
  cursor: crosshair;
  touch-action: none;
}

.shapePlot__canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.shapePlot__box {
  position: absolute;
  border: 1px solid var(--cs-accent);
  background: #2f9e4426;
  pointer-events: none;
}

.shapePlot__band {
  position: absolute;
  right: 4px;
  font-size: 10px;
  color: var(--cs-mute);
  transform: translateY(50%);
  pointer-events: none;
}

.shapePlot__tip {
  position: absolute;
  padding: 1px 6px;
  border: 1px solid var(--cs-line);
  border-radius: 4px;
  background: #1a1c1e;
  font-size: 11px;
  white-space: nowrap;
  transform: translate(8px, -120%);
  pointer-events: none;
}

.shapePlot__xAxis {
  position: relative;
  height: 16px;
  font-size: 10px;
  color: var(--cs-mute);
}

.shapePlot__xAxis span {
  position: absolute;
  top: 3px;
  transform: translateX(-50%);
}
</style>
