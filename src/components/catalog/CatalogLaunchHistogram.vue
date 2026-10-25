<!-- Launches per year; dragging across the bars picks a range of years. -->
<template>
  <catalog-histogram
    icon="lucide:rocket"
    title="Launches per year"
    pick-hint="drag to pick years"
    :chart-label="`Launches per year since ${FIRST_YEAR}`"
    :bins="YEARS"
    :series="series"
    :range="range"
    :format-bin="String"
    :format-range="([from, to]) => `${from}–${to}`"
    :ticks="ticks"
    :height="height"
    :open="open"
    @update:range="emit('update:range', $event)"
    @toggle-open="emit('toggle-open')"
  >
    <template #stats>
      <span
        ><b>{{ stats.total.toLocaleString() }}</b> launched, under the other filters</span
      >
      <span v-if="stats.peak"
        >peak <b>{{ stats.peak[0] }}</b> with {{ stats.peak[1].toLocaleString() }}</span
      >
      <span>{{ stats.recentShare }}% since {{ RECENT_FROM }}</span>
    </template>
  </catalog-histogram>
</template>

<script setup lang="ts">
import { computed } from "vue";

import CatalogHistogram, { type HistogramTick } from "./CatalogHistogram.vue";

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

/** Below ~380 px a decade's label meets the next; opened wide, every fifth year fits. */
function ticks(width: number): HistogramTick[] {
  const narrow = width < 380;
  const wide = props.open && width >= 900;
  const labelEvery = narrow ? 20 : wide ? 5 : 10;
  const tickEvery = narrow ? 10 : wide ? 1 : 5;
  return YEARS.flatMap((year, i) => (year % tickEvery === 0 ? [{ at: i + 0.5, label: year % labelEvery === 0 ? String(year) : "" }] : []));
}

/** The launches as the chart's one series. */
const series = computed(() => [{ label: "Launches", counts: props.launches }]);

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
</script>
