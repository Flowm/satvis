<!-- Launches per year, with axes; dragging across the bars picks a range of years. -->
<template>
  <div ref="rootEl" class="histogram cs-measured">
    <div class="cs-tileHead">
      <UIcon name="lucide:rocket" class="cs-mute" /> Launches per year
      <span class="cs-mute cs-hint" title="Square-root scale, so the 2020s do not flatten the years before">√ scale</span>
      <span v-if="range" class="cs-dim cs-num">{{ range[0] }}–{{ range[1] }}</span>
      <span v-else class="cs-mute cs-hint">drag to pick years</span>
      <span class="cs-headEnd">
        <button v-if="range" type="button" class="cs-reset" @click="emit('update:range', null)">reset</button>
        <catalog-tile-toggle :open="open" label="launches per year" @click="emit('toggle-open')" />
      </span>
    </div>
    <div v-if="open" class="histogram__stats cs-num">
      <span
        ><b>{{ stats.total.toLocaleString() }}</b> launched, under the other filters</span
      >
      <span v-if="stats.peak"
        >peak <b>{{ stats.peak[0] }}</b> with {{ stats.peak[1].toLocaleString() }}</span
      >
      <span>{{ stats.recentShare }}% since {{ RECENT_FROM }}</span>
    </div>
    <div class="histogram__chart">
      <div class="histogram__yAxis cs-num" :style="{ height: `${height}px` }">
        <span v-for="tick in yTicks" :key="tick.value" :style="{ bottom: `${tick.height}%` }">{{ tick.label }}</span>
      </div>
      <div class="histogram__plot">
        <svg
          ref="svgEl"
          class="histogram__bars"
          :style="{ height: `${height}px` }"
          :viewBox="`0 0 ${YEARS.length} 100`"
          preserveAspectRatio="none"
          role="img"
          :aria-label="`Launches per year since ${FIRST_YEAR}`"
          @pointerdown="brushStart"
          @pointermove="brushMove"
          @pointerup="brushEnd"
          @pointerleave="hoverYear = null"
        >
          <line v-for="tick in yTicks" :key="tick.value" x1="0" :x2="YEARS.length" :y1="100 - tick.height" :y2="100 - tick.height" class="histogram__grid" />
          <rect v-if="hoverYear !== null" :x="hoverYear - FIRST_YEAR" width="1" y="0" height="100" class="histogram__hover" />
          <rect
            v-for="(year, i) in YEARS"
            :key="year"
            :x="i + 0.1"
            width="0.8"
            :y="100 - barHeight(year)"
            :height="barHeight(year)"
            :class="inRange(year) ? (range ? 'histogram__bar--picked' : 'histogram__bar') : 'histogram__bar--out'"
          />
        </svg>
        <span v-if="hoverYear !== null" class="histogram__tip cs-num" :style="{ left: `${xPercent(hoverYear)}%` }"
          ><b>{{ hoverYear }}</b> {{ (launches.get(hoverYear) ?? 0).toLocaleString() }}</span
        >
        <div class="histogram__xAxis cs-num">
          <span v-for="year in xTicks" :key="year" :class="{ 'histogram__tick--labelled': year % labelEvery === 0 }" :style="{ left: `${xPercent(year)}%` }">{{
            year % labelEvery === 0 ? year : ""
          }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import CatalogTileToggle from "./CatalogTileToggle.vue";

const props = defineProps<{
  /** Launch year -> satellites, under every filter but the year range. */
  launches: Map<number, number>;
  range: [number, number] | null;
  /** Px, the bars' height. */
  height: number;
  open: boolean;
}>();
const emit = defineEmits<{ "update:range": [range: [number, number] | null]; "toggle-open": [] }>();

/** Sputnik. */
const FIRST_YEAR = 1957;
/** Every year from Sputnik to now. */
const YEARS = Array.from({ length: new Date().getFullYear() - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);
/** Where the stats' recent share starts: the decade the megaconstellations launched in. */
const RECENT_FROM = 2020;

// The chart's width, which decides how many years get a label.
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

// Below ~380 px a decade's label meets the next; opened wide, every fifth year fits.
const narrow = computed(() => width.value < 380);
const wide = computed(() => props.open && width.value >= 900);
const labelEvery = computed(() => (narrow.value ? 20 : wide.value ? 5 : 10));
const xTicks = computed(() => YEARS.filter((year) => year % (narrow.value ? 10 : wide.value ? 1 : 5) === 0));
/** A year's bar centre, % of the plot's width. */
const xPercent = (year: number) => ((year - FIRST_YEAR + 0.5) / YEARS.length) * 100;

/** The tallest bar's count. */
const max = computed(() => Math.max(1, ...props.launches.values()));
// Square root: the Starlink years would flatten every year before 2019.
const barHeight = (year: number) => (Math.sqrt(props.launches.get(year) ?? 0) / Math.sqrt(max.value)) * 96;
/** Inside the picked years, or no years are picked. */
const inRange = (year: number) => !props.range || (year >= props.range[0] && year <= props.range[1]);

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

/** The opened chart's totals, under the other filters. */
const stats = computed(() => {
  let total = 0;
  let recent = 0;
  let peak: [number, number] | undefined;
  for (const [year, count] of props.launches) {
    total += count;
    if (year >= RECENT_FROM) recent += count;
    if (!peak || count > peak[1]) peak = [year, count];
  }
  return { total, peak, recentShare: total ? Math.round((recent / total) * 100) : 0 };
});

// The brush: the year under the pointer, and where a drag began.
const svgEl = ref<SVGSVGElement | null>(null);
const hoverYear = ref<number | null>(null);
let brushFrom: number | null = null;

/** The year whose bar is under the pointer. */
function yearAt(event: PointerEvent): number {
  const rect = svgEl.value!.getBoundingClientRect();
  const i = Math.floor(((event.clientX - rect.left) / rect.width) * YEARS.length);
  return FIRST_YEAR + Math.max(0, Math.min(YEARS.length - 1, i));
}
/** Starts a range at the year pressed. */
function brushStart(event: PointerEvent): void {
  svgEl.value?.setPointerCapture(event.pointerId);
  brushFrom = yearAt(event);
  emit("update:range", [brushFrom, brushFrom]);
}
/** Tracks the hovered year, and stretches the range while dragging. */
function brushMove(event: PointerEvent): void {
  const year = yearAt(event);
  hoverYear.value = year;
  if (brushFrom !== null) emit("update:range", [Math.min(brushFrom, year), Math.max(brushFrom, year)]);
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

.histogram__stats b {
  font-weight: 600;
  color: var(--cs-text);
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

/* The tick mark; a labelled year gets a longer one. */
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
</style>
