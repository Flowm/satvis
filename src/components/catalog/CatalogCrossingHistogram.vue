<!-- Sun-sync satellites by when and which way they cross the equator, in daylight or at both nodes; dragging picks a range of times. -->
<template>
  <catalog-histogram
    v-model:picked="direction"
    icon="lucide:sunrise"
    title="Sun-sync crossing"
    :title-hint="`${viewDef.titleHint} Away from the equator a pass comes earlier or later than this, by about an hour at 60° latitude, and the other way round for the other direction.`"
    pick-hint="drag to pick times"
    :chart-label="viewDef.chartLabel"
    :bins="bins"
    :series="series"
    v-model:scale="scale"
    :range="binRange"
    :format-bin="(bin) => `${formatLocalTime(hoursOf(bin))}–${formatLocalTime(hoursOf(bin + 1))}`"
    :format-range="([from, to]) => `${formatLocalTime(hoursOf(from))}–${formatLocalTime(hoursOf(to + 1))}`"
    :ticks="ticks"
    :bands="bands"
    :height="height"
    :open="open"
    @update:range="emit('update:range', $event && [hoursOf($event[0]), hoursOf($event[1] + 1)])"
    @toggle-open="emit('toggle-open')"
  >
    <template #controls>
      <catalog-segments :model-value="view" :options="Object.values(VIEWS)" label="Hours" @update:model-value="pickView" />
    </template>
    <template #stats>
      <span
        ><b>{{ formatInteger(stats.total) }}</b> sun-sync, under the other filters</span
      >
      <span
        >{{ viewDef.southboundLabel }} <b>{{ stats.southboundShare }}%</b></span
      >
      <span v-for="regime in REGIMES" :key="regime.label" :title="regime.hint"
        >{{ regime.label }} <b>{{ stats.shares[regime.label] }}%</b></span
      >
    </template>
  </catalog-histogram>
</template>

<script setup lang="ts">
import { computed } from "vue";

import type { CrossingView, HistogramScale } from "../../composables/useCatalogFilters";
import { CROSSING_BIN_HOURS, CROSSING_FROM_HOURS, type CrossingDirection, formatLocalTime } from "../../modules/catalogFacets";
import { formatInteger } from "../../modules/util/formats";
import CatalogHistogram, { type HistogramBand, type HistogramSeries, type HistogramTick } from "./CatalogHistogram.vue";
import CatalogSegments, { type SegmentOption } from "./CatalogSegments.vue";

const props = defineProps<{
  /** Per direction, crossing bin from 00:00 -> sun-sync satellites, under every filter but the crossing. */
  crossings: Record<CrossingDirection, Map<number, number>>;
  /** Hours, from inclusive to exclusive. */
  range: [number, number] | null;
  /** Px, the bars' height. */
  height: number;
  open: boolean;
}>();
const emit = defineEmits<{ "update:range": [range: [number, number] | null]; "toggle-open": [] }>();
/** The bars' scale, picked in the heading. */
const scale = defineModel<HistogramScale>("scale", { required: true });
/** The direction picked in the legend. */
const direction = defineModel<CrossingDirection | null>("direction", { required: true });
/** The hours shown, picked in the heading. */
const view = defineModel<CrossingView>("view", { required: true });

/** A view: its button, its hours, and what the chart says about it. */
interface ViewDef extends SegmentOption<CrossingView> {
  /** From inclusive to exclusive. */
  hours: [number, number];
  /** The title's hint. */
  titleHint: string;
  chartLabel: string;
  /** Hours between tick labels: narrow, at its usual width, and opened wide. */
  labelEvery: [number, number, number];
  /** The opened chart's southbound share, which counts the daylit crossings alone. */
  southboundLabel: string;
}

/** The views, as the heading names them. */
const VIEWS: Record<CrossingView, ViewDef> = {
  daylit: {
    value: "daylit",
    label: "12h",
    name: "Daylit crossing, 06:00–18:00",
    hint: "06:00–18:00: each satellite once, at its daylit crossing",
    hours: [CROSSING_FROM_HOURS, CROSSING_FROM_HOURS + 12],
    titleHint:
      "When a sun-sync satellite crosses the equator in daylight, in mean solar time, and which way: southbound at its descending node, northbound at its ascending node. The night crossing is 12 hours off.",
    chartLabel: "Sun-sync satellites by the local time and direction of their daylit equator crossing",
    labelEvery: [3, 2, 1],
    southboundLabel: "southbound",
  },
  fullDay: {
    value: "fullDay",
    label: "24h",
    name: "Both crossings, 00:00–24:00",
    hint: "00:00–24:00: each satellite twice, at its ascending and its descending node",
    hours: [0, 24],
    titleHint:
      "When a sun-sync satellite crosses the equator, in mean solar time, at both nodes: northbound at its ascending node (LTAN), southbound at its descending node (LTDN), 12 hours apart. Each satellite counts twice. A direction picked alone filters by the daylit crossing.",
    chartLabel: "Sun-sync satellites by the local time of their ascending and descending node",
    labelEvery: [6, 4, 2],
    southboundLabel: "southbound by day",
  },
};
/** The picked view. */
const viewDef = computed(() => VIEWS[view.value]);

/** Bins per hour. */
const PER_HOUR = 1 / CROSSING_BIN_HOURS;
/** A bin's start, in hours of the day. */
const hoursOf = (bin: number) => bin * CROSSING_BIN_HOURS;
/** Every bin of the view's hours. */
const bins = computed(() => {
  const [from, to] = viewDef.value.hours;
  return Array.from({ length: (to - from) * PER_HOUR }, (_, i) => from * PER_HOUR + i);
});

/** Switches the view, trimming the range of times to what it shows, or dropping a range it shows none of. */
function pickView(next: CrossingView): void {
  const [from, to] = VIEWS[next].hours;
  if (props.range) {
    const trimmed: [number, number] = [Math.max(props.range[0], from), Math.min(props.range[1], to)];
    if (trimmed[0] !== props.range[0] || trimmed[1] !== props.range[1]) emit("update:range", trimmed[0] < trimmed[1] ? trimmed : null);
  }
  view.value = next;
}

/** Both ends' hint: a dawn-dusk orbit lands at either, by which side of 06:00 or 18:00 its nodes fall. */
const DAWN_DUSK_HINT = "Dawn-dusk: crossing within an hour of 06:00 or 18:00, so the orbit rides the terminator, in sunlight most of the year";
/**
 * Hours where the orbits Earth observation flies crowd: the band labels, and the opened chart's
 * shares. Across 24 hours, dawn and dusk take an hour either side of 06:00 and 18:00, where a
 * dawn-dusk orbit crosses at both of its nodes.
 */
const REGIMES = [
  { label: "dawn", short: "dawn", hours: [6, 7], fullDayHours: [5, 7], hint: DAWN_DUSK_HINT },
  { label: "morning", short: "AM", hours: [9, 12], hint: "Morning orbits, crossing 09:00–12:00" },
  { label: "afternoon", short: "PM", hours: [12, 15], hint: "Afternoon orbits, crossing 12:00–15:00" },
  { label: "dusk", short: "dusk", hours: [17, 18], fullDayHours: [17, 19], hint: DAWN_DUSK_HINT },
] as const;
/** Px, the narrowest chart whose 24 hours fit "morning" beside "afternoon". */
const FULL_DAY_LABELS_WIDTH = 380;

/** The regimes shaded behind the bars; in the 24-hour view morning and afternoon fainter again at their night crossing, and AM and PM where narrow. */
function bands(width: number): HistogramBand[] {
  const [from] = viewDef.value.hours;
  const fullDay = view.value === "fullDay";
  const bandOf = ([start, end]: readonly [number, number], label: string): HistogramBand => ({ at: (start - from) * PER_HOUR, width: (end - start) * PER_HOUR, label });
  return REGIMES.flatMap((regime) => {
    if (!fullDay) return [bandOf(regime.hours, regime.label)];
    const label = width < FULL_DAY_LABELS_WIDTH ? regime.short : regime.label;
    if ("fullDayHours" in regime) return [bandOf(regime.fullDayHours, label)];
    const band = bandOf(regime.hours, label);
    return [band, { ...band, at: ((regime.hours[0] + 12) % 24) * PER_HOUR, label: "", faint: true }];
  });
}

/** The directions, southbound at the bottom: most morning orbits, the busiest. */
const series = computed<HistogramSeries[]>(() => [
  { label: "southbound", short: "↓", hint: "At the descending node (LTDN)", counts: props.crossings.southbound },
  { label: "northbound", short: "↑", hint: "At the ascending node (LTAN)", counts: props.crossings.northbound },
]);

/** Hours as bins, inclusive. */
const binsOf = ([from, to]: [number, number]): [number, number] => [Math.round(from * PER_HOUR), Math.round(to * PER_HOUR) - 1];
/** The picked hours as bins; in the 24-hour view a direction picked alone keeps the daylit hours, where it filters. */
const binRange = computed<[number, number] | null>(() => {
  if (props.range) return binsOf(props.range);
  return direction.value && view.value === "fullDay" ? binsOf(VIEWS.daylit.hours) : null;
});

/** A tick every hour, labelled as the view spaces them for the chart's width. */
function ticks(width: number): HistogramTick[] {
  const {
    hours: [from, to],
    labelEvery: [narrow, usual, wide],
  } = viewDef.value;
  const labelEvery = width < 380 ? narrow : props.open && width >= 900 ? wide : usual;
  return Array.from({ length: to - from + 1 }, (_, i) => ({ at: i * PER_HOUR, label: i % labelEvery === 0 ? formatLocalTime(from + i) : "" }));
}

/** The daylit hours, where each satellite has exactly one crossing. */
const [DAYLIT_FROM, DAYLIT_TO] = VIEWS.daylit.hours;
/** The opened chart's total, the southbound share, and each regime's share, by the daylit crossings alone in either view. */
const stats = computed(() => {
  let total = 0;
  let southbound = 0;
  const counts: Record<string, number> = {};
  for (const [way, map] of Object.entries(props.crossings)) {
    for (const [bin, count] of map) {
      const hours = hoursOf(bin);
      if (hours < DAYLIT_FROM || hours >= DAYLIT_TO) continue;
      total += count;
      if (way === "southbound") southbound += count;
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
