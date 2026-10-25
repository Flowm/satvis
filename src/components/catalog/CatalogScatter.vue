<!-- Satellites as dots on two axes, on a canvas, as ~17,000 SVG nodes would be too many; dragging a box picks a region. -->
<template>
  <div class="scatter cs-measured">
    <div class="cs-tileHead">
      <UIcon :name="icon" class="cs-mute" /> {{ title }}
      <span v-if="box" class="cs-dim cs-num">{{ rangeText(y, box.y) }} · {{ rangeText(x, box.x) }}</span>
      <span class="cs-headEnd">
        <button v-if="box" type="button" class="cs-reset" @click="emit('update:box', null)">reset</button>
        <catalog-tile-toggle :open="open" :label="title.toLowerCase()" @click="emit('toggle-open')" />
      </span>
    </div>
    <div v-if="open" class="scatter__legend">
      <span v-for="item in LEGEND" :key="item.label"><i :style="{ background: item.color }" />{{ item.label }}</span>
      <span class="cs-mute"><i class="scatter__faint" />outside the other filters</span>
    </div>
    <div class="scatter__chart" :style="{ height: `${height}px` }">
      <div class="scatter__yAxis cs-num">
        <span v-for="tick in yTicks" :key="tick" :style="{ bottom: `${fraction(y, tick) * 100}%` }">{{ y.format(tick) }}</span>
      </div>
      <div
        ref="plotEl"
        class="scatter__plot"
        role="img"
        :aria-label="`${chartLabel}; drag a box to filter`"
        @pointerdown="dragStart"
        @pointermove="dragMove"
        @pointerup="dragEnd"
        @pointerleave="hover = null"
      >
        <canvas ref="canvasEl" class="scatter__canvas" />
        <div v-if="boxStyle" class="scatter__box" :style="boxStyle" />
        <span
          v-for="mark in marks"
          :key="mark.label"
          class="scatter__mark"
          :class="{ 'scatter__mark--edge': mark.x === undefined }"
          :style="{ bottom: `${fraction(y, mark.y) * 100}%`, left: mark.x === undefined ? undefined : `${fraction(x, mark.x) * 100}%` }"
          >{{ mark.label }}</span
        >
        <span v-if="hover" class="scatter__tip cs-num" :style="{ left: `${hover.px}px`, top: `${hover.py}px` }"
          >{{ y.format(hover.y) }}{{ y.unit }} · {{ x.format(hover.x) }}{{ x.unit }}<span v-if="!box" class="scatter__tipHint">drag a box to filter</span></span
        >
      </div>
    </div>
    <div class="scatter__xAxis cs-num">
      <span v-for="tick in xTicks" :key="tick" :style="{ left: `calc(32px + (100% - 32px) * ${fraction(x, tick)})` }">{{ x.format(tick) }}{{ x.tickUnit }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { ORBIT_CLASS_COLOR, orbitColor, SUN_SYNC_COLOR } from "../../config/orbitClass";
import type { CatalogRow } from "../../modules/catalogFacets";
import CatalogTileToggle from "./CatalogTileToggle.vue";

/** One of the plot's axes. */
export interface ScatterAxis {
  /** The ends drawn; a value beyond one is drawn at it. */
  min: number;
  max: number;
  log: boolean;
  /** The values a box reaching an end stands for, so it takes in what is drawn there; ±Infinity unless given. */
  limits?: [number, number];
  /** The ticks for the axis's length in px. */
  ticks: (px: number) => readonly number[];
  format: (value: number) => string;
  /** After a formatted value in the heading and the tooltip: " km", "°". */
  unit: string;
  /** After a tick's label. */
  tickUnit?: string;
  value: (row: CatalogRow) => number;
}

/** A box in the axes' values. */
export interface ScatterBox {
  x: [number, number];
  y: [number, number];
}

/** A label at a value on the y axis: at the right edge, or at `x`. */
export interface ScatterMark {
  label: string;
  x?: number;
  y: number;
}

/** Px from the plot's left and top for each axis's value, and the plot's size. */
export interface ScatterScale {
  x: (value: number) => number;
  y: (value: number) => number;
  width: number;
  height: number;
}

const props = defineProps<{
  /** A lucide icon name. */
  icon: string;
  title: string;
  /** The chart's accessible name. */
  chartLabel: string;
  x: ScatterAxis;
  y: ScatterAxis;
  rows: readonly CatalogRow[];
  /** The rows passing every filter but the box: drawn bright, the rest faint for context. */
  brightRows: readonly CatalogRow[];
  box: ScatterBox | null;
  marks?: readonly ScatterMark[];
  /** Draws under the grid and the dots. */
  drawUnder?: (ctx: CanvasRenderingContext2D, scale: ScatterScale) => void;
  /** Px, the plot's height. */
  height: number;
  open: boolean;
}>();
const emit = defineEmits<{ "update:box": [box: ScatterBox | null]; "toggle-open": [] }>();

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

/** 0 at the axis's start, 1 at its end; a value beyond an end sits on it. */
function fraction(axis: ScatterAxis, value: number): number {
  const clamped = Math.min(Math.max(value, axis.min), axis.max);
  return axis.log ? Math.log(clamped / axis.min) / Math.log(axis.max / axis.min) : (clamped - axis.min) / (axis.max - axis.min);
}
/** The inverse of fraction. */
function valueAt(axis: ScatterAxis, f: number): number {
  return axis.log ? axis.min * (axis.max / axis.min) ** f : axis.min + f * (axis.max - axis.min);
}
/** A picked range, open-ended where it reaches an infinite limit, or "any" at both. */
function rangeText(axis: ScatterAxis, [from, to]: [number, number]): string {
  if (from === -Infinity && to === Infinity) return "any";
  if (to === Infinity) return `over ${axis.format(from)}${axis.unit}`;
  if (from === -Infinity) return `under ${axis.format(to)}${axis.unit}`;
  return `${axis.format(from)}–${axis.format(to)}${axis.unit}`;
}

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

const xTicks = computed(() => props.x.ticks(size.value.width));
const yTicks = computed(() => props.y.ticks(props.height));

/** The bright rows, for a constant-time check while drawing. */
const brightSet = computed(() => new Set(props.brightRows));

/** The class's colour, but blue for LEO's grey. */
function dotColor(row: CatalogRow): string {
  const color = orbitColor(row.orbitClass, row.orbitKind);
  return color === ORBIT_CLASS_COLOR.LEO ? LEO_DOT : color;
}

/** Redraws everything: what is under, the grid, the faint rows, then the bright ones. */
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
  const scale: ScatterScale = { x: (value) => fraction(props.x, value) * width, y: (value) => height - fraction(props.y, value) * height, width, height };

  props.drawUnder?.(ctx, scale);
  ctx.strokeStyle = "#ffffff12";
  ctx.beginPath();
  for (const tick of yTicks.value) {
    ctx.moveTo(0, scale.y(tick));
    ctx.lineTo(width, scale.y(tick));
  }
  for (const tick of xTicks.value) {
    ctx.moveTo(scale.x(tick), 0);
    ctx.lineTo(scale.x(tick), height);
  }
  ctx.stroke();

  ctx.fillStyle = "#ffffff14";
  for (const row of props.rows) {
    if (!brightSet.value.has(row)) {
      ctx.fillRect(scale.x(props.x.value(row)) - 1, scale.y(props.y.value(row)) - 1, 2, 2);
    }
  }
  ctx.globalAlpha = 0.75;
  for (const row of props.brightRows) {
    ctx.fillStyle = dotColor(row);
    ctx.fillRect(scale.x(props.x.value(row)) - 1, scale.y(props.y.value(row)) - 1, 2.5, 2.5);
  }
  ctx.globalAlpha = 1;
}

// Not requestAnimationFrame: a hidden tab never runs it, and the plot would stay blank.
watch([size, () => props.rows, () => props.brightRows, xTicks, yTicks], () => setTimeout(draw), { immediate: true });

// The pointer: where it is, and the box it drags.
const hover = ref<{ px: number; py: number; x: number; y: number } | null>(null);
const drag = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

/** The pointer in the plot's px, clamped to it. */
function local(event: PointerEvent): { px: number; py: number } {
  const rect = plotEl.value!.getBoundingClientRect();
  return { px: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), py: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) };
}
/** Starts a box at the pointer. */
function dragStart(event: PointerEvent): void {
  plotEl.value?.setPointerCapture(event.pointerId);
  const { px, py } = local(event);
  drag.value = { x0: px, y0: py, x1: px, y1: py };
}
/** Tracks the pointer for the tooltip, and grows the box while dragging. */
function dragMove(event: PointerEvent): void {
  const { px, py } = local(event);
  const { width, height } = size.value;
  hover.value = { px, py, x: valueAt(props.x, px / width), y: valueAt(props.y, 1 - py / height) };
  if (drag.value) {
    drag.value = { ...drag.value, x1: px, y1: py };
  }
}
/** An axis's range between two fractions, an end reaching past the axis where the box touches it. */
function rangeOf(axis: ScatterAxis, f0: number, f1: number, edge: number): [number, number] {
  const [low, high] = axis.limits ?? [-Infinity, Infinity];
  const from = Math.min(f0, f1);
  const to = Math.max(f0, f1);
  return [from <= edge ? low : valueAt(axis, from), to >= 1 - edge ? high : valueAt(axis, to)];
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
  // Half a px, so a box dragged to the clamped edge counts as touching it.
  emit("update:box", {
    x: rangeOf(props.x, d.x0 / width, d.x1 / width, 0.5 / width),
    y: rangeOf(props.y, 1 - d.y0 / height, 1 - d.y1 / height, 0.5 / height),
  });
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
  const x0 = fraction(props.x, props.box.x[0]) * width;
  const x1 = fraction(props.x, props.box.x[1]) * width;
  const y0 = height - fraction(props.y, props.box.y[1]) * height;
  const y1 = height - fraction(props.y, props.box.y[0]) * height;
  return { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` };
});
</script>

<style scoped>
.scatter__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: -2px 0 8px;
  font-size: 11px;
  color: var(--cs-dim);
}

.scatter__legend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 5px;
  border-radius: 2px;
}

.scatter__legend .scatter__faint {
  background: #ffffff30;
}

.scatter__chart {
  display: flex;
  gap: 6px;
  transition: height 0.3s ease;
}

.scatter__yAxis {
  position: relative;
  flex: none;
  width: 26px;
  font-size: 10px;
  color: var(--cs-mute);
}

.scatter__yAxis span {
  position: absolute;
  right: 0;
  transform: translateY(50%);
}

.scatter__plot {
  position: relative;
  flex: 1;
  min-width: 0;
  border-bottom: 1px solid #ffffff40;
  border-left: 1px solid #ffffff40;
  cursor: crosshair;
  touch-action: none;
}

.scatter__canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.scatter__box {
  position: absolute;
  border: 1px solid var(--cs-accent);
  background: #2f9e4426;
  pointer-events: none;
}

.scatter__mark {
  position: absolute;
  padding-left: 4px;
  font-size: 10px;
  color: var(--cs-mute);
  white-space: nowrap;
  transform: translateY(50%);
  pointer-events: none;
}

.scatter__mark--edge {
  right: 4px;
  padding-left: 0;
}

.scatter__tip {
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

.scatter__tipHint {
  display: block;
  font-size: 10px;
  color: var(--cs-mute);
}

.scatter__xAxis {
  position: relative;
  height: 16px;
  font-size: 10px;
  color: var(--cs-mute);
}

.scatter__xAxis span {
  position: absolute;
  top: 3px;
  transform: translateX(-50%);
}
</style>
