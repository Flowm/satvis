<!--
  The sweep (ADR 0016): the first N of the whole catalog with a set of components, past every
  budget, at a clock rate, then what the steps add up to.
-->
<template>
  <fieldset class="bench__section bench__settings" :disabled="panel.running.value">
    <label class="bench__field">
      <span>Counts</span>
      <input v-model="form.countsText" type="text" spellcheck="false" inputmode="numeric" />
    </label>
    <div class="bench__field">
      <span>Components</span>
      <div class="bench__inline">
        <label v-for="option in MODES" :key="option.value" :title="option.hint">
          <input v-model="form.mode" type="radio" :value="option.value" />
          {{ option.label }}
        </label>
      </div>
    </div>
    <!-- The propagation axis; see DEFAULT_CLOCK_MULTIPLIERS. -->
    <label class="bench__field">
      <span>Clock ×</span>
      <input v-model="form.clocksText" type="text" spellcheck="false" inputmode="decimal" />
    </label>
  </fieldset>
  <div class="bench__section bench__actions">
    <button v-if="panel.running.value" type="button" class="bench__button" @click="panel.cancel()">Cancel</button>
    <button v-else type="button" class="bench__button bench__button--primary" :disabled="panel.sweepSteps.value.length === 0" @click="void panel.startSweep()">
      Run {{ panel.sweepSteps.value.length }} {{ panel.sweepSteps.value.length === 1 ? "step" : "steps" }}
    </button>
  </div>

  <!-- Above the tables: every derived table inherits a thin row's noise. -->
  <p v-if="thin > 0" class="bench__section bench__warn bench__notice">
    {{ thin }} of {{ rows.length }} steps sampled under {{ MIN_TRUSTWORTHY_FRAMES }} frames: those rows, and everything derived from them, are noise. Keep the app in front.
  </p>

  <template v-if="run">
    <benchmark-table caption="Steps" :columns="stepColumns" :rows="stepRows" />
    <benchmark-table v-if="scaling.length > 0" caption="Scaling: CPU ms per 1,000 satellites; the floor is the GPU or the refresh" :columns="SCALING_COLUMNS" :rows="scaling" />
    <benchmark-table v-if="memory.length > 0" :caption="memoryCaption" :columns="memoryColumns" :rows="memory">
      <!-- Not struck through: the negative slope is the tell of a mid-series collection. -->
      <p v-if="memoryUnreadable" class="bench__caption bench__bad">
        That slope cannot be read: it needs {{ MIN_MEMORY_FIT_POINTS }} or more counts and r² {{ MIN_TRUSTWORTHY_MEMORY_R2 }}, or a garbage collection landed inside the series.
        Sweep more counts, or run again.
      </p>
    </benchmark-table>
    <!-- An empty table would read as "propagation is free". -->
    <benchmark-table v-if="propagation.length > 0" caption="Propagation: against the same scene at ×1" :columns="PROPAGATION_COLUMNS" :rows="propagation" />
    <benchmark-table v-if="marginal.length > 0" caption="Marginal: what each component adds to CPU ms" :columns="MARGINAL_COLUMNS" :rows="marginal" />
    <benchmark-table v-if="drift.length > 0" caption="Drift: the first step again at the end" :columns="DRIFT_COLUMNS" :rows="drift" />
  </template>

  <div class="bench__section bench__actions">
    <button type="button" class="bench__button" :disabled="!run" @click="log()">Log</button>
    <button type="button" class="bench__button" :disabled="!run" @click="void copy('csv')">Copy CSV</button>
    <button type="button" class="bench__button" :disabled="!run" @click="void copy('json')">Copy JSON</button>
    <button type="button" class="bench__button" :disabled="!run" @click="void copy('table')">Copy table</button>
    <p v-if="copied" class="bench__caption bench__actions-caption">{{ copied }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

import {
  absoluteFitTrustworthy,
  formatLoad,
  formatTable,
  hasFootprints,
  isDrifted,
  logRun,
  marginalCosts,
  memoryFits,
  memoryFitTrustworthy,
  MIN_MEMORY_FIT_POINTS,
  MIN_TRUSTWORTHY_FRAMES,
  MIN_TRUSTWORTHY_MEMORY_R2,
  propagationCosts,
  repeatChecks,
  reportRows,
  scalingFits,
  toCsv,
  toJson,
} from "@/modules/benchmark";
import { formatFixed, formatInteger } from "@/modules/util/formats";

import { type ComponentMode, useBenchmarkPanel } from "./benchmarkPanel";
import BenchmarkTable, { type TableColumn, type TableRow } from "./BenchmarkTable.vue";
import { copyText } from "./copyText";

/** `current` is the default: one pass rather than seven or eight. */
const MODES: { value: ComponentMode; label: string; hint: string }[] = [
  { value: "current", label: "current", hint: "Only the components switched on now" },
  { value: "isolated", label: "isolated", hint: "Point, and Point with each other component" },
  { value: "cumulative", label: "cumulative", hint: "One component added at a time, on top of the last" },
];
/** Below FPS_BAD a row is red, below FPS_WARN yellow: a 60 Hz display measures 59.8. */
const FPS_BAD = 30;
const FPS_WARN = 55;

const SCALING_COLUMNS: TableColumn[] = [
  { key: "series", label: "series" },
  { key: "slope", label: "ms/1k", numeric: true },
  { key: "base", label: "base", numeric: true },
  { key: "r2", label: "r²", numeric: true },
  { key: "floor", label: "floor", numeric: true },
  { key: "at60", label: "sats@60", numeric: true, title: "Satellites at which the CPU fills a 60 fps frame" },
];
const PROPAGATION_COLUMNS: TableColumn[] = [
  { key: "sats", label: "sats", numeric: true },
  { key: "clock", label: "clock", numeric: true },
  { key: "main", label: "CPU ms", numeric: true },
  { key: "delta", label: "Δ CPU", numeric: true },
  { key: "perSat", label: "µs/sat", numeric: true },
  { key: "total", label: "Δ total %", numeric: true, title: "Every thread's CPU, in % of one core: propagation off the main thread counts here" },
  { key: "components", label: "components" },
];
const MARGINAL_COLUMNS: TableColumn[] = [
  { key: "sats", label: "sats", numeric: true },
  { key: "clock", label: "clock", numeric: true },
  { key: "added", label: "added" },
  { key: "delta", label: "Δ CPU", numeric: true },
  { key: "perSat", label: "µs/sat", numeric: true },
  { key: "over", label: "over" },
];
const DRIFT_COLUMNS: TableColumn[] = [
  { key: "sats", label: "sats", numeric: true },
  { key: "first", label: "CPU 1st", numeric: true },
  { key: "again", label: "again", numeric: true },
  { key: "drift", label: "drift", numeric: true },
  { key: "buildFirst", label: "build 1st", numeric: true },
  { key: "buildAgain", label: "again", numeric: true },
  { key: "buildDrift", label: "drift", numeric: true },
];

const panel = useBenchmarkPanel();
const { form } = panel;
const copied = ref("");

const run = computed(() => panel.sweepRun.value);
const rows = computed(() => (run.value ? reportRows(run.value) : []));

/** A table cell: an integer, or a number to `digits` places; a dash where the cell is empty. */
const num = (value: number | "", digits: number): string => (value === "" ? "–" : digits === 0 ? formatInteger(value) : formatFixed(value, digits));
/** A change in percent, with its sign. */
const signed = (percent: number): string => `${percent > 0 ? "+" : ""}${formatFixed(percent, 1)} %`;

const thin = computed(() => rows.value.filter((row) => row.frames < MIN_TRUSTWORTHY_FRAMES).length);
/** From the rows, not the form, so a console-started sweep shows it too. */
const clockSwept = computed(() => rows.value.some((row) => row.clock !== 1));
/** The report blanks the whole column when the driver's clock is not believable. */
const gpuShown = computed(() => rows.value.some((row) => row.gpuMs !== ""));
const footprints = computed(() => run.value !== undefined && hasFootprints(run.value));

/** The performance panel's figures, in its order. */
const stepColumns = computed<TableColumn[]>(() => [
  { key: "sats", label: "sats", numeric: true },
  { key: "visible", label: "drawn", numeric: true },
  ...(clockSwept.value ? [{ key: "clock", label: "clock", numeric: true }] : []),
  { key: "fps", label: "fps", numeric: true },
  { key: "cpu", label: "CPU", numeric: true, title: "Main-thread ms a frame: what sets the frame rate" },
  ...(gpuShown.value ? [{ key: "gpu", label: "GPU", numeric: true }] : []),
  { key: "load", label: "load %", numeric: true, title: "The busier of CPU and GPU; at least the CPU's where the GPU's is unknown" },
  footprints.value
    ? { key: "mb", label: "MB", numeric: true, title: "The absolute footprint measureUserAgentSpecificMemory gave" }
    : { key: "mb", label: "heap", numeric: true, title: "Chrome's JS heap after the step, garbage included: not the native app's footprint" },
  { key: "cpuP95", label: "p95 CPU", numeric: true },
  ...(gpuShown.value ? [{ key: "gpuP95", label: "p95 GPU", numeric: true }] : []),
  { key: "over", label: "over %", numeric: true, title: "Frames whose CPU or GPU work outlasted the frame budget" },
  { key: "total", label: "total CPU %", numeric: true, title: "At least: the frames and what the workers report, in % of one core; the browser reports no process time" },
  { key: "build", label: "build", numeric: true, title: "ms to a complete scene" },
  { key: "components", label: "components" },
]);
const stepRows = computed<TableRow[]>(() =>
  rows.value.map((row, index) => ({
    key: index,
    struck: row.frames < MIN_TRUSTWORTHY_FRAMES,
    title: `${row.frames} frames sampled`,
    cells: {
      sats: formatInteger(row.sats),
      visible: formatInteger(row.visible),
      clock: `×${row.clock}`,
      fps: formatFixed(row.fps, 1),
      cpu: num(row.cpuMs, 2),
      gpu: num(row.gpuMs, 2),
      load: formatLoad(row.loadPct === "" ? null : row.loadPct, row.cpuBusyPct === "" ? null : row.cpuBusyPct),
      mb: num(row.footprintMb === "" ? row.heapMb : row.footprintMb, 0),
      cpuP95: num(row.cpuP95Ms, 2),
      gpuP95: num(row.gpuP95Ms, 2),
      over: num(row.overBudgetPct, 0),
      total: row.cpuTotalPct === "" ? "–" : `≥ ${num(row.cpuTotalPct, 0)}`,
      build: formatInteger(row.buildMs),
      components: `${row.components}${row.repeat ? " (repeat)" : ""}${row.drawn ? ` → drew ${row.drawn}` : ""}`,
    },
    tones: { fps: row.fps < FPS_BAD ? "bad" : row.fps < FPS_WARN ? "warn" : undefined },
  })),
);

const scaling = computed<TableRow[]>(() =>
  run.value && run.value.results.length > 1
    ? scalingFits(run.value).map((fit) => ({
        key: fit.series,
        cells: {
          series: fit.series,
          slope: formatFixed(fit.cpuMsPer1000, 2),
          base: formatFixed(fit.baseCpuMs, 2),
          r2: formatFixed(fit.r2, 3),
          floor: formatFixed(fit.floorMs, 2),
          at60: fit.satsAt60fps === "" ? "–" : formatInteger(fit.satsAt60fps),
        },
        tones: { r2: fit.r2 < 0.9 ? "warn" : undefined },
      }))
    : [],
);

const memoryFitList = computed(() => (run.value && run.value.results.length > 1 ? memoryFits(run.value) : []));
const memoryCaption = computed(() =>
  footprints.value
    ? "Memory per 1,000 satellites: heap growth, and the absolute footprint's"
    : "Memory per 1,000 satellites: heap growth, relative; within 2 % of a forced collection when r² holds",
);
const memoryColumns = computed<TableColumn[]>(() => [
  { key: "series", label: "series" },
  { key: "mb", label: "MB/1k", numeric: true },
  { key: "kb", label: "KB/sat", numeric: true },
  ...(footprints.value ? [{ key: "absolute", label: "absolute", numeric: true, title: "KB a satellite from absolute footprints; agreement with KB/sat means both hold" }] : []),
  { key: "r2", label: "r²", numeric: true },
]);
const memory = computed<TableRow[]>(() =>
  memoryFitList.value.map((fit) => ({
    key: fit.series,
    cells: { series: fit.series, mb: num(fit.mbPer1000Sats, 1), kb: num(fit.kbPerSatellite, 1), absolute: num(fit.absoluteKbPerSatellite, 1), r2: num(fit.r2, 3) },
    tones: {
      absolute: fit.absoluteKbPerSatellite === "" ? undefined : absoluteFitTrustworthy(fit) ? "good" : "bad",
      r2: fit.r2 === "" ? undefined : memoryFitTrustworthy(fit) ? "good" : "bad",
    },
  })),
);
const memoryUnreadable = computed(() => memoryFitList.value.some((fit) => fit.r2 !== "" && !memoryFitTrustworthy(fit)));

const propagation = computed<TableRow[]>(() =>
  (run.value ? propagationCosts(run.value) : []).map((cost, index) => ({
    key: index,
    cells: {
      sats: formatInteger(cost.sats),
      clock: `×${cost.clock}`,
      main: formatFixed(cost.cpuMs, 2),
      delta: formatFixed(cost.deltaCpuMs, 2),
      perSat: formatFixed(cost.usPerSatellite, 1),
      total: num(cost.deltaCpuTotalPct, 1),
      components: cost.components,
    },
  })),
);

const marginal = computed<TableRow[]>(() =>
  (run.value ? marginalCosts(run.value) : []).map((cost, index) => ({
    key: index,
    cells: {
      sats: formatInteger(cost.sats),
      clock: `×${cost.clock}`,
      added: cost.added,
      delta: formatFixed(cost.deltaCpuMs, 2),
      perSat: formatFixed(cost.usPerSatellite, 1),
      over: cost.over,
    },
  })),
);

const drift = computed<TableRow[]>(() =>
  (run.value ? repeatChecks(run.value) : []).map((check, index) => ({
    key: index,
    cells: {
      sats: formatInteger(check.sats),
      first: formatFixed(check.firstCpuMs, 2),
      again: formatFixed(check.repeatCpuMs, 2),
      drift: signed(check.cpuDriftPct),
      buildFirst: formatInteger(check.firstBuildMs),
      buildAgain: formatInteger(check.repeatBuildMs),
      buildDrift: signed(check.buildDriftPct),
    },
    tones: { drift: isDrifted(check) ? "bad" : "good" },
  })),
);

/** Logs the sweep's tables to the console. */
function log(): void {
  if (run.value) {
    logRun(run.value);
  }
}

/** Copies the sweep as CSV, JSON or the text tables, and says so for two seconds. */
async function copy(format: "csv" | "json" | "table"): Promise<void> {
  if (!run.value) {
    return;
  }
  const text = format === "csv" ? toCsv(run.value) : format === "json" ? toJson(run.value) : formatTable(run.value);
  copied.value = await copyText(text, format === "table" ? "table" : format.toUpperCase());
  setTimeout(() => {
    copied.value = "";
  }, 2000);
}
</script>

<style>
.bench__settings {
  margin: 0;
  padding: 0;
  border: 0;
}

.bench__field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
}

.bench__field > span:first-child {
  flex: none;
  width: 76px;
  color: var(--bench-dim);
}

.bench__field > input[type="text"] {
  flex: 1;
}

.bench__inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
}

.bench__notice {
  margin: 0;
}
</style>
