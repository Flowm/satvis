<!-- Counts per bin on a square-root scale, with axes; dragging across the bars picks a range of bins, and a series' legend entry picks the series. -->
<template>
  <div ref="rootEl" class="histogram cs-measured">
    <div class="cs-tileHead">
      <UIcon :name="icon" class="cs-mute" /> <span :title="titleHint">{{ title }}</span>
      <span class="cs-mute cs-hint" title="Square-root scale, so the tallest bars do not flatten the rest">√ scale</span>
      <span v-if="range" class="cs-dim cs-num">{{ formatRange(range) }}</span>
      <span v-else class="cs-mute cs-hint">{{ pickHint }}</span>
      <span class="cs-headEnd">
        <button v-if="range || picked" type="button" class="cs-reset" @click="reset">reset</button>
        <catalog-tile-toggle :open="open" :label="title.charAt(0).toLowerCase() + title.slice(1)" @click="emit('toggle-open')" />
      </span>
    </div>
    <div v-if="open" class="histogram__stats cs-num"><slot name="stats" /></div>
    <div v-if="series.length > 1" class="histogram__legend">
      <button
        v-for="(s, i) in series"
        :key="s.label"
        type="button"
        :aria-pressed="picked === s.label"
        :class="{ 'histogram__legend--off': picked && picked !== s.label }"
        :title="s.hint"
        @click="emit('update:picked', picked === s.label ? null : s.label)"
      >
        <i :style="{ background: colorOf(i) }" />{{ s.label }}
      </button>
    </div>
    <div class="histogram__chart">
      <div class="histogram__yAxis cs-num" :class="{ 'histogram__yAxis--banded': bands?.length }" :style="{ height: `${height}px` }">
        <span v-for="tick in yTicks" :key="tick.value" :style="{ bottom: `${tick.height}%` }">{{ tick.label }}</span>
      </div>
      <div class="histogram__plot">
        <!-- Above the bars, which reach the top. -->
        <div v-if="bands?.length" class="histogram__bandLabels">
          <span v-for="band in bands" :key="band.at" :style="{ left: `${((band.at + band.width / 2) / bins.length) * 100}%` }">{{ band.label }}</span>
        </div>
        <svg
          ref="svgEl"
          class="histogram__bars"
          :style="{ height: `${height}px` }"
          :viewBox="`0 0 ${bins.length} 100`"
          preserveAspectRatio="none"
          role="img"
          :aria-label="chartLabel"
          @pointerdown="brushStart"
          @pointermove="brushMove"
          @pointerup="brushEnd"
          @pointerleave="hoverIndex = null"
        >
          <rect v-for="band in bands" :key="band.at" :x="band.at" :width="band.width" y="0" height="100" class="histogram__band" />
          <line v-for="tick in yTicks" :key="tick.value" x1="0" :x2="bins.length" :y1="100 - tick.height" :y2="100 - tick.height" class="histogram__grid" />
          <rect v-if="hoverIndex !== null" :x="hoverIndex" width="1" y="0" height="100" class="histogram__hover" />
          <template v-for="(bin, i) in bins" :key="bin">
            <rect
              v-for="segment in segmentsOf(bin)"
              :key="segment.series"
              :x="i + 0.1"
              width="0.8"
              :y="100 - segment.top"
              :height="segment.height"
              :class="segmentClass(bin, segment.series)"
              :style="segmentStyle(bin, segment.series)"
            />
          </template>
        </svg>
        <span v-if="hoverIndex !== null" class="histogram__tip cs-num" :style="{ left: `${((hoverIndex + 0.5) / bins.length) * 100}%` }"
          ><b>{{ formatBin(bins[hoverIndex]!) }}</b> {{ tipOf(bins[hoverIndex]!) }}</span
        >
        <div class="histogram__xAxis cs-num">
          <span
            v-for="tick in xTicks"
            :key="tick.at"
            :class="{ 'histogram__tick--labelled': tick.label !== '', 'histogram__tick--start': tick.at === 0, 'histogram__tick--end': tick.at === bins.length }"
            :style="{ left: `${(tick.at / bins.length) * 100}%` }"
            >{{ tick.label }}</span
          >
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import CatalogTileToggle from "./CatalogTileToggle.vue";

/** An x axis tick, `at` in bins from the left edge; an empty label is a minor tick. */
export interface HistogramTick {
  at: number;
  label: string;
}

/** A shaded span behind the bars, `at` and `width` in bins. */
export interface HistogramBand {
  at: number;
  width: number;
  label: string;
}

/** One stacked part of every bar. */
export interface HistogramSeries {
  /** In the legend, and what picking the series emits. */
  label: string;
  /** In the tooltip; the label where missing. */
  short?: string;
  /** What the series means, on hover over its legend entry. */
  hint?: string;
  /** Bin key -> satellites, under every filter but the chart's own. */
  counts: Map<number, number>;
}

/** The series' colours, in order; one series alone takes the theme's link and accent instead. */
const SERIES_COLORS = ["#74c0fc", "#ffa94d"];

const props = defineProps<{
  /** A lucide icon name. */
  icon: string;
  title: string;
  /** What the title means, on hover. */
  titleHint?: string;
  /** Shown in the heading while nothing is picked. */
  pickHint: string;
  /** The chart's accessible name. */
  chartLabel: string;
  /** Every bin's key, left to right. */
  bins: readonly number[];
  /** Stacked bottom up. */
  series: readonly HistogramSeries[];
  /** The series picked in the legend, by label. */
  picked?: string | null;
  /** Inclusive bin keys. */
  range: [number, number] | null;
  formatBin: (bin: number) => string;
  formatRange: (range: [number, number]) => string;
  /** The x axis ticks for the chart's width in px. */
  ticks: (width: number) => readonly HistogramTick[];
  bands?: readonly HistogramBand[];
  /** Px, the bars' height. */
  height: number;
  open: boolean;
}>();
const emit = defineEmits<{ "update:range": [range: [number, number] | null]; "update:picked": [label: string | null]; "toggle-open": [] }>();

/** Clears the range and the picked series. */
function reset(): void {
  emit("update:range", null);
  if (props.picked) emit("update:picked", null);
}

// The chart's width, which decides how many ticks get a label.
const rootEl = ref<HTMLElement | null>(null);
const width = ref(600);
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry) width.value = entry.contentRect.width;
  });
  if (rootEl.value) observer.observe(rootEl.value);
});
onBeforeUnmount(() => observer?.disconnect());

const xTicks = computed(() => props.ticks(width.value));

/** Each bin's count across the series. */
const totals = computed(() => {
  const result = new Map<number, number>();
  for (const { counts } of props.series) {
    for (const [bin, count] of counts) result.set(bin, (result.get(bin) ?? 0) + count);
  }
  return result;
});
/** The tallest bar's count. */
const max = computed(() => Math.max(1, ...totals.value.values()));
/** Inside the picked bins, or no bins are picked. */
const inRange = (bin: number) => !props.range || (bin >= props.range[0] && bin <= props.range[1]);
const colorOf = (series: number) => SERIES_COLORS[series % SERIES_COLORS.length];

/**
 * A bar's parts, bottom up. The bar is as tall as its total on the square-root scale, and each
 * series takes its share of that height: stacked square roots would overstate the total.
 */
function segmentsOf(bin: number): { series: number; top: number; height: number }[] {
  const total = totals.value.get(bin) ?? 0;
  const barHeight = (Math.sqrt(total) / Math.sqrt(max.value)) * 96;
  let top = 0;
  return props.series.flatMap(({ counts }, series) => {
    const count = counts.get(bin) ?? 0;
    if (count === 0) return [];
    const height = (barHeight * count) / total;
    top += height;
    return [{ series, top, height }];
  });
}
/** Out of the range or the picked series: grey. One series alone is the link colour, or the accent within a range. */
function segmentClass(bin: number, series: number): string {
  if (!inRange(bin) || (props.picked && props.series[series]!.label !== props.picked)) return "histogram__bar--out";
  if (props.series.length > 1) return "";
  return props.range ? "histogram__bar--picked" : "histogram__bar";
}
/** A series' colour, where its class gives none. */
function segmentStyle(bin: number, series: number) {
  return props.series.length > 1 && segmentClass(bin, series) === "" ? { fill: colorOf(series) } : undefined;
}
/** "12", or "↓ 12 · ↑ 3" for several series. */
function tipOf(bin: number): string {
  if (props.series.length === 1) return (props.series[0]!.counts.get(bin) ?? 0).toLocaleString();
  return props.series.map((s) => `${s.short ?? s.label} ${(s.counts.get(bin) ?? 0).toLocaleString()}`).join(" · ");
}

/** 1-2-5 steps up to the tallest bar, thinned so their labels stay ~14 px apart on the square-root scale. */
const yTicks = computed(() => {
  const ticks: { value: number; height: number; label: string }[] = [];
  const minGap = (14 / props.height) * 100;
  let last = 0;
  for (let magnitude = 1; magnitude <= max.value; magnitude *= 10) {
    for (const step of [1, 2, 5]) {
      const value = step * magnitude;
      if (value > max.value) break;
      const height = (Math.sqrt(value) / Math.sqrt(max.value)) * 96;
      if (height - last < minGap) continue;
      ticks.push({ value, height, label: value >= 1000 ? `${value / 1000}k` : String(value) });
      last = height;
    }
  }
  return ticks;
});

// The brush: the bin under the pointer, and where a drag began.
const svgEl = ref<SVGSVGElement | null>(null);
const hoverIndex = ref<number | null>(null);
let brushFrom: number | null = null;

/** The index of the bin under the pointer. */
function indexAt(event: PointerEvent): number {
  const rect = svgEl.value!.getBoundingClientRect();
  const i = Math.floor(((event.clientX - rect.left) / rect.width) * props.bins.length);
  return Math.max(0, Math.min(props.bins.length - 1, i));
}
/** Starts a range at the bin pressed. */
function brushStart(event: PointerEvent): void {
  svgEl.value?.setPointerCapture(event.pointerId);
  brushFrom = props.bins[indexAt(event)]!;
  emit("update:range", [brushFrom, brushFrom]);
}
/** Tracks the hovered bin, and stretches the range while dragging. */
function brushMove(event: PointerEvent): void {
  const i = indexAt(event);
  hoverIndex.value = i;
  const bin = props.bins[i]!;
  if (brushFrom !== null) emit("update:range", [Math.min(brushFrom, bin), Math.max(brushFrom, bin)]);
}
/** Ends the drag; the range stays. */
function brushEnd(): void {
  brushFrom = null;
}
</script>

<style scoped>
.histogram__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: -2px 0 8px;
  font-size: 12px;
  color: var(--cs-dim);
}

.histogram__stats :deep(b) {
  font-weight: 600;
  color: var(--cs-text);
}

.histogram__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 4px;
  margin: -4px 0 4px;
  font-size: 11px;
}

.histogram__legend button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--cs-dim);
}

.histogram__legend button:hover {
  background: #ffffff10;
}

.histogram__legend button[aria-pressed="true"] {
  color: var(--cs-text);
  box-shadow: inset 0 0 0 1px var(--cs-line);
}

.histogram__legend i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.histogram__legend .histogram__legend--off {
  opacity: 0.5;
}

.histogram__chart {
  display: flex;
  gap: 6px;
}

.histogram__yAxis {
  position: relative;
  flex: none;
  width: 26px;
  font-size: 10px;
  color: var(--cs-mute);
  transition: height 0.3s ease;
}

.histogram__yAxis span {
  position: absolute;
  right: 0;
  transform: translateY(50%);
}

.histogram__plot {
  position: relative;
  flex: 1;
  min-width: 0;
}

.histogram__bars {
  display: block;
  width: 100%;
  border-bottom: 1px solid #ffffff40;
  cursor: crosshair;
  touch-action: none;
  transition: height 0.3s ease;
}

.histogram__grid {
  stroke: #ffffff14;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.histogram__band {
  fill: #ffffff0a;
}

.histogram__bandLabels {
  position: relative;
  height: 13px;
  font-size: 10px;
  line-height: 13px;
  color: var(--cs-mute);
}

.histogram__bandLabels span {
  position: absolute;
  white-space: nowrap;
  transform: translateX(-50%);
}

/* Down by the band labels' strip, to stay level with the bars. */
.histogram__yAxis--banded {
  margin-top: 13px;
}

.histogram__bar {
  fill: var(--cs-link);
}

.histogram__bar--picked {
  fill: var(--cs-accent);
}

.histogram__bar--out {
  fill: #ffffff26;
}

.histogram__hover {
  fill: #ffffff10;
}

.histogram__tip {
  position: absolute;
  top: -4px;
  padding: 1px 6px;
  border: 1px solid var(--cs-line);
  border-radius: 4px;
  background: #1a1c1e;
  font-size: 11px;
  white-space: nowrap;
  transform: translateX(-50%);
  pointer-events: none;
}

.histogram__tip b {
  margin-right: 4px;
  font-weight: 600;
}

.histogram__xAxis {
  position: relative;
  height: 18px;
  font-size: 10px;
  color: var(--cs-mute);
}

.histogram__xAxis span {
  position: absolute;
  top: 0;
  padding-top: 5px;
  transform: translateX(-50%);
}

/* The tick mark; a labelled tick gets a longer one. */
.histogram__xAxis span::before {
  content: "";
  position: absolute;
  top: 0;
  left: 50%;
  width: 1px;
  height: 3px;
  background: #ffffff40;
}

.histogram__xAxis .histogram__tick--labelled::before {
  height: 5px;
  background: #ffffff80;
}

/* The ticks at the plot's ends keep their labels inside it. */
.histogram__xAxis .histogram__tick--start {
  transform: none;
}

.histogram__xAxis .histogram__tick--start::before {
  left: 0;
}

.histogram__xAxis .histogram__tick--end {
  transform: translateX(-100%);
}

.histogram__xAxis .histogram__tick--end::before {
  left: auto;
  right: 0;
}
</style>
