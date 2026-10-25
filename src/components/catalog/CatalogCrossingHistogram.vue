<!-- Sun-sync satellites by when and which way they cross the equator in daylight; dragging picks a range of times. -->
<template>
  <catalog-histogram
    v-model:picked="direction"
    icon="lucide:sunrise"
    title="Sun-sync crossing"
    title-hint="When a sun-sync satellite crosses the equator in daylight, in mean solar time, and which way: southbound at its descending node, northbound at its ascending node. The night crossing is 12 hours off. Away from the equator a pass comes earlier or later than this, by about an hour at 60° latitude, and the other way round for the other direction."
    pick-hint="drag to pick times"
    chart-label="Sun-sync satellites by the local time and direction of their daylit equator crossing"
    :bins="BINS"
    :series="series"
    :range="binRange"
    :format-bin="(bin) => `${formatLocalTime(hoursOf(bin))}–${formatLocalTime(hoursOf(bin + 1))}`"
    :format-range="() => `${formatLocalTime(range![0])}–${formatLocalTime(range![1])}`"
    :ticks="ticks"
    :bands="BANDS"
    :height="height"
    :open="open"
    @update:range="emit('update:range', $event && [hoursOf($event[0]), hoursOf($event[1] + 1)])"
    @toggle-open="emit('toggle-open')"
  >
    <template #stats>
      <span
        ><b>{{ stats.total.toLocaleString() }}</b> sun-sync, under the other filters</span
      >
      <span
        >southbound <b>{{ stats.southboundShare }}%</b></span
      >
      <span v-for="regime in REGIMES" :key="regime.label" :title="regime.hint"
        >{{ regime.label }} <b>{{ stats.shares[regime.label] }}%</b></span
      >
    </template>
  </catalog-histogram>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { CROSSING_BIN_HOURS, CROSSING_FROM_HOURS, type CrossingDirection, formatLocalTime } from "../../modules/catalogFacets";
import CatalogHistogram, { type HistogramBand, type HistogramSeries, type HistogramTick } from "./CatalogHistogram.vue";

const props = defineProps<{
  /** Per direction, crossing bin -> sun-sync satellites, under every filter but the crossing. */
  crossings: Record<CrossingDirection, Map<number, number>>;
  /** Hours, from inclusive to exclusive. */
  range: [number, number] | null;
  /** Px, the bars' height. */
  height: number;
  open: boolean;
}>();
const emit = defineEmits<{ "update:range": [range: [number, number] | null]; "toggle-open": [] }>();
/** The direction picked in the legend. */
const direction = defineModel<CrossingDirection | null>("direction", { required: true });

/** Bins per hour. */
const PER_HOUR = 1 / CROSSING_BIN_HOURS;
/** Every bin of the 12 daylit hours. */
const BINS = Array.from({ length: 12 * PER_HOUR }, (_, i) => i);
/** A bin's start, in hours of the day. */
const hoursOf = (bin: number) => CROSSING_FROM_HOURS + bin * CROSSING_BIN_HOURS;

/** Hours where the orbits Earth observation flies crowd: the band labels, and the opened chart's shares. */
const REGIMES = [
  { label: "dawn", hours: [6, 7], hint: "Dawn-dusk: crossing within an hour of 06:00 or 18:00, so the orbit rides the terminator, in sunlight most of the year" },
  { label: "morning", hours: [9, 12], hint: "Morning orbits, crossing 09:00–12:00" },
  { label: "afternoon", hours: [12, 15], hint: "Afternoon orbits, crossing 12:00–15:00" },
  { label: "dusk", hours: [17, 18], hint: "Dawn-dusk: crossing within an hour of 06:00 or 18:00, so the orbit rides the terminator, in sunlight most of the year" },
] as const;
const BANDS: HistogramBand[] = REGIMES.map(({ label, hours: [from, to] }) => ({ at: (from - CROSSING_FROM_HOURS) * PER_HOUR, width: (to - from) * PER_HOUR, label }));

/** The directions, southbound at the bottom: most morning orbits, the busiest. */
const series = computed<HistogramSeries[]>(() => [
  { label: "southbound", short: "↓", hint: "At the descending node (LTDN)", counts: props.crossings.southbound },
  { label: "northbound", short: "↑", hint: "At the ascending node (LTAN)", counts: props.crossings.northbound },
]);

/** The picked hours as bins, inclusive. */
const binRange = computed<[number, number] | null>(
  () => props.range && [Math.round((props.range[0] - CROSSING_FROM_HOURS) * PER_HOUR), Math.round((props.range[1] - CROSSING_FROM_HOURS) * PER_HOUR) - 1],
);

/** A tick every hour, labelled every 3 hours where narrow, else every 2, or every hour opened wide. */
function ticks(width: number): HistogramTick[] {
  const labelEvery = width < 380 ? 3 : props.open && width >= 900 ? 1 : 2;
  return Array.from({ length: 13 }, (_, i) => ({ at: i * PER_HOUR, label: i % labelEvery === 0 ? formatLocalTime(CROSSING_FROM_HOURS + i) : "" }));
}

/** The opened chart's total, the southbound share, and each regime's share. */
const stats = computed(() => {
  let total = 0;
  let southbound = 0;
  const counts: Record<string, number> = {};
  for (const [way, map] of Object.entries(props.crossings)) {
    for (const [bin, count] of map) {
      total += count;
      if (way === "southbound") southbound += count;
      const hours = hoursOf(bin);
      for (const {
        label,
        hours: [from, to],
      } of REGIMES) {
        if (hours >= from && hours < to) counts[label] = (counts[label] ?? 0) + count;
      }
    }
  }
  const share = (count: number) => (total ? Math.round((count / total) * 100) : 0);
  return { total, southboundShare: share(southbound), shares: Object.fromEntries(REGIMES.map(({ label }) => [label, share(counts[label] ?? 0)])) };
});
</script>
