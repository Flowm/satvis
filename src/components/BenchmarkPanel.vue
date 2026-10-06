<!--
  The benchmark panel (see src/modules/benchmark/README.md). Plain CSS, not Nuxt
  UI, to fit a dozen numbers densely. It shares `window.bench` with the console.
-->
<template>
  <div class="bench" :class="{ 'bench--below-fps': showFps }">
    <div class="bench__bar">
      <span class="bench__title">BENCHMARK</span>
      <button type="button" class="bench__x" title="Close" @click="emit('close')">×</button>
    </div>

    <!-- The panel turns render-on-demand off on open; this shows if something turned it back on. -->
    <div v-if="renderOnDemand" class="bench__alert">
      render-on-demand is on — these are gaps between requested frames, not a frame rate.
      <button type="button" @click="disableRenderOnDemand()">turn off</button>
    </div>

    <div class="bench__live">
      <div class="bench__row bench__row--big">
        <span :class="['bench__fps', fpsClass]">{{ live.fps.toFixed(1) }}</span>
        <span class="bench__unit">fps</span>
        <span class="bench__sep">·</span>
        <span
          >frame <b>{{ live.frameMs.toFixed(2) }}</b> ms</span
        >
        <span class="bench__sep">·</span>
        <span
          >cpu <b>{{ live.cpuMs.toFixed(2) }}</b> ms</span
        >
        <template v-if="live.gpuMs !== undefined">
          <span class="bench__sep">·</span>
          <span
            >gpu <b>{{ live.gpuMs.toFixed(2) }}</b> ms</span
          >
        </template>
      </div>
      <div class="bench__row bench__dim">
        <!-- The raw heap floor; only the memory fit makes it comparable. -->
        p95 {{ live.p95Ms.toFixed(2) }} · worst {{ live.worstMs.toFixed(2) }} · jank {{ live.jankPct.toFixed(0) }}% · heap
        {{ live.heapMb === undefined ? "n/a" : `${live.heapMb.toFixed(0)} MB` }}
      </div>
      <div class="bench__row bench__dim">
        {{ live.satellites }} sats · {{ live.components || "no components" }} · ×{{ live.clock }} · {{ live.entities }} entities · {{ live.primitives }} primitives
      </div>
    </div>

    <div class="bench__body">
      <div class="bench__block">
        <!-- Run, Cancel and the status stay outside the fold, so a running sweep's Cancel is never hidden. -->
        <button type="button" class="bench__fold" :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen">
          <span class="bench__chevron">{{ settingsOpen ? "▾" : "▸" }}</span>
          settings
          <span v-if="!settingsOpen" class="bench__dim">{{ settingsSummary }}</span>
        </button>
        <template v-if="settingsOpen">
          <label class="bench__field">
            <span>counts</span>
            <input v-model="countsText" type="text" spellcheck="false" :disabled="running" />
          </label>
          <div class="bench__field">
            <span>sat comps</span>
            <div class="bench__modes">
              <label v-for="option in MODES" :key="option.value" class="bench__mode" :title="option.hint">
                <input v-model="mode" type="radio" :value="option.value" :disabled="running" />
                {{ option.label }}
              </label>
            </div>
          </div>
          <!-- The propagation axis; see DEFAULT_CLOCK_MULTIPLIERS. -->
          <label class="bench__field">
            <span>clock</span>
            <input v-model="clocksText" type="text" spellcheck="false" :disabled="running" />
            <span class="bench__dim">×</span>
          </label>
          <div class="bench__field">
            <span>timing</span>
            <div class="bench__inline">
              <label>warmup <input v-model.number="warmupMs" type="number" min="0" step="250" :disabled="running" /></label>
              <label>sample <input v-model.number="sampleMs" type="number" min="250" step="250" :disabled="running" /></label>
              <span class="bench__dim">ms</span>
            </div>
          </div>
          <div class="bench__field">
            <span>extras</span>
            <div class="bench__inline">
              <label><input v-model="withGroundStation" type="checkbox" :disabled="running" /> ground station (pass prediction)</label>
              <!-- Disabled, not hidden, so its tooltip can say the page is not cross-origin isolated. -->
              <label :title="footprintHint">
                <input v-model="withFootprint" type="checkbox" :disabled="running || !footprintAvailable" />
                accurate memory footprint (measureUAM, ~17 s/step)
              </label>
            </div>
          </div>
        </template>
        <div class="bench__row">
          <button type="button" class="bench__run" :disabled="running || plan.length === 0" @click="void start()">Run {{ plan.length }} steps</button>
          <button type="button" :disabled="!running" @click="cancel()">Cancel</button>
          <span class="bench__dim">≈ {{ estimateText }}</span>
        </div>
        <div class="bench__row bench__dim">{{ status }}</div>
      </div>

      <!-- Above the tables: every derived table inherits a thin row's noise. -->
      <div v-if="thin > 0" class="bench__block bench__warn">
        {{ thin }}/{{ rows.length }} steps sampled under {{ MIN_TRUSTWORTHY_FRAMES }} frames — those rows, and everything derived from them, are noise. Keep the tab in front.
      </div>

      <div v-if="rows.length > 0" class="bench__block bench__block--table">
        <table class="bench__table">
          <thead>
            <tr>
              <th class="bench__num">sats</th>
              <th class="bench__num">vis</th>
              <th v-if="clockSwept" class="bench__num">clock</th>
              <th class="bench__num">fps</th>
              <th class="bench__num">frame</th>
              <th class="bench__num">p95</th>
              <th class="bench__num">cpu</th>
              <th v-if="gpuColumn" class="bench__num">gpu</th>
              <th class="bench__num">build</th>
              <th v-if="footprintColumn" class="bench__num">footprint</th>
              <th>components</th>
            </tr>
          </thead>
          <tbody>
            <!-- Thin rows are struck through, not dropped. -->
            <tr v-for="(row, index) in rows" :key="index" :class="{ bench__thin: row.frames < MIN_TRUSTWORTHY_FRAMES }">
              <td class="bench__num">{{ row.sats }}</td>
              <td class="bench__num">{{ row.visible }}</td>
              <td v-if="clockSwept" class="bench__num">×{{ row.clock }}</td>
              <td :class="['bench__num', row.fps < FPS_BAD ? 'bench__bad' : row.fps < FPS_WARN ? 'bench__warn' : '']" :title="`${row.frames} frames sampled`">
                {{ row.fps.toFixed(1) }}
              </td>
              <td class="bench__num">{{ row.frameMs.toFixed(2) }}</td>
              <td class="bench__num">{{ row.p95Ms.toFixed(2) }}</td>
              <td class="bench__num">{{ row.cpuMs.toFixed(2) }}</td>
              <td v-if="gpuColumn" class="bench__num">{{ row.gpuMs === "" ? "—" : row.gpuMs.toFixed(2) }}</td>
              <td class="bench__num">{{ row.buildMs.toFixed(0) }}</td>
              <td v-if="footprintColumn" class="bench__num">{{ row.footprintMb === "" ? "—" : row.footprintMb }}</td>
              <td>
                {{ row.components }}<span v-if="row.drawn" class="bench__warn"> → drew {{ row.drawn }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="fits.length > 0" class="bench__block bench__block--table">
        <div class="bench__caption">scaling (main-thread ms per 1,000 satellites; floor is GPU plus vsync)</div>
        <table class="bench__table">
          <thead>
            <tr>
              <th>series</th>
              <th class="bench__num">ms/1k</th>
              <th class="bench__num">base</th>
              <th class="bench__num">r²</th>
              <th class="bench__num">floor</th>
              <th class="bench__num">sats@60</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="fit in fits" :key="fit.series">
              <td>{{ fit.series }}</td>
              <td class="bench__num">{{ fit.mainMsPer1000.toFixed(2) }}</td>
              <td class="bench__num">{{ fit.baseMainMs.toFixed(2) }}</td>
              <td :class="['bench__num', fit.r2 < 0.9 ? 'bench__warn' : '']">{{ fit.r2.toFixed(3) }}</td>
              <td class="bench__num">{{ fit.floorMs.toFixed(2) }}</td>
              <td class="bench__num">{{ fit.satsAt60fps === "" ? "—" : fit.satsAt60fps }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Slopes only: the heap floor includes garbage, so an intercept here would read as a footprint. -->
      <div v-if="memory.length > 0" class="bench__block bench__block--table">
        <div class="bench__caption">memory (heap growth per 1,000 satellites — relative; within 2% of a forced GC when r² holds)</div>
        <table class="bench__table">
          <thead>
            <tr>
              <th>series</th>
              <th class="bench__num">MB/1k</th>
              <th class="bench__num">KB/sat</th>
              <th v-if="footprintColumn" class="bench__num" title="The same slope from absolute footprints, with its own r². Agreement with KB/sat means both can be trusted.">
                absolute
              </th>
              <th class="bench__num">r²</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="fit in memory" :key="fit.series">
              <td>{{ fit.series }}</td>
              <!-- A series without a floor fit may still have an absolute one. -->
              <td class="bench__num">{{ fit.mbPer1000Sats?.toFixed(1) ?? "—" }}</td>
              <td class="bench__num">{{ fit.kbPerSatellite?.toFixed(1) ?? "—" }}</td>
              <td v-if="footprintColumn" :class="['bench__num', fit.absoluteKbPerSatellite === undefined ? '' : absoluteFitTrustworthy(fit) ? 'bench__good' : 'bench__bad']">
                {{ fit.absoluteKbPerSatellite === undefined ? "—" : fit.absoluteKbPerSatellite.toFixed(1) }}
              </td>
              <td :class="['bench__num', fit.r2 === undefined ? '' : memoryFitTrustworthy(fit) ? 'bench__good' : 'bench__bad']">{{ fit.r2?.toFixed(3) ?? "—" }}</td>
            </tr>
          </tbody>
        </table>
        <!-- Not struck through: the negative slope is the tell of a mid-series GC. -->
        <div v-if="memory.some((fit) => fit.r2 !== undefined && !memoryFitTrustworthy(fit))" class="bench__row bench__bad">
          that slope cannot be read — it needs {{ MIN_MEMORY_FIT_POINTS }}+ counts and r² {{ MIN_TRUSTWORTHY_MEMORY_R2 }}, or a garbage collection landed inside the series and its
          offset is not common to the rows. Sweep more counts, or re-run.
        </div>
      </div>

      <!-- An empty table would read as "propagation is free". -->
      <div v-if="propagation.length > 0" class="bench__block bench__block--table">
        <div class="bench__caption">propagation (clock-tick ms over the same scene at ×1)</div>
        <table class="bench__table">
          <thead>
            <tr>
              <th class="bench__num">sats</th>
              <th class="bench__num">clock</th>
              <th class="bench__num">tick</th>
              <th class="bench__num">Δ</th>
              <th class="bench__num">µs/sat</th>
              <th class="bench__num">cpu</th>
              <th>components</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(cost, index) in propagation" :key="index">
              <td class="bench__num">{{ cost.sats }}</td>
              <td class="bench__num">×{{ cost.clock }}</td>
              <td class="bench__num">{{ cost.tickMs.toFixed(2) }}</td>
              <td class="bench__num">{{ cost.deltaTickMs.toFixed(2) }}</td>
              <td class="bench__num">{{ cost.usPerSatellite.toFixed(1) }}</td>
              <td class="bench__num">{{ cost.cpuMs.toFixed(2) }}</td>
              <td>{{ cost.components }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Drift: if the re-run differs, the app moved under the sweep. -->
      <div v-if="repeats.length > 0" class="bench__block bench__block--table">
        <div class="bench__caption">first step re-run at the end (drift)</div>
        <table class="bench__table">
          <thead>
            <tr>
              <th class="bench__num">sats</th>
              <th class="bench__num">main 1st</th>
              <th class="bench__num">main again</th>
              <th class="bench__num">drift</th>
              <th class="bench__num">build 1st</th>
              <th class="bench__num">build again</th>
              <th class="bench__num">drift</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(check, index) in repeats" :key="index">
              <td class="bench__num">{{ check.sats }}</td>
              <td class="bench__num">{{ check.firstMainMs.toFixed(2) }}</td>
              <td class="bench__num">{{ check.repeatMainMs.toFixed(2) }}</td>
              <td :class="['bench__num', isDrifted(check) ? 'bench__bad' : 'bench__good']">{{ signed(check.mainDriftPct) }}</td>
              <td class="bench__num">{{ check.firstBuildMs.toFixed(0) }}</td>
              <td class="bench__num">{{ check.repeatBuildMs.toFixed(0) }}</td>
              <td class="bench__num">{{ signed(check.buildDriftPct) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="bench__block bench__row">
        <button type="button" :disabled="rows.length === 0" @click="logToConsole()">Log</button>
        <button type="button" :disabled="rows.length === 0" @click="void copy('csv')">Copy CSV</button>
        <button type="button" :disabled="rows.length === 0" @click="void copy('json')">Copy JSON</button>
        <button type="button" :disabled="rows.length === 0" @click="void copy('text')">Copy table</button>
        <span v-if="copied" class="bench__dim">{{ copied }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

import { useController } from "../composables/useController";
import {
  CUMULATIVE_COMPONENT_SETS,
  DEFAULT_OPTIONS,
  DEFAULT_SATELLITE_COUNTS,
  ISOLATED_COMPONENT_SETS,
  buildPlan,
  canMeasureFootprint,
  estimateDurationMs,
  FOOTPRINT_CAPTURE_MS,
  formatComponents,
  installBenchmark,
  logRun,
  marginalCosts,
  memoryFits,
  propagationCosts,
  reportRows,
  scalingFits,
  repeatChecks,
  toCsv,
  toJson,
  formatTable,
  GPU_TIMER_TRUST_FACTOR,
  MIN_MEMORY_FIT_POINTS,
  MIN_TRUSTWORTHY_FRAMES,
  MIN_TRUSTWORTHY_MEMORY_R2,
  absoluteFitTrustworthy,
  hasFootprints,
  memoryFitTrustworthy,
  type BenchmarkRun,
  type MemoryFit,
  type PropagationCost,
  isDrifted,
  type RepeatCheck,
  type ReportRow,
  type ScalingFit,
} from "../modules/benchmark";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";

const emit = defineEmits<{ close: [] }>();

const cc = useController();
const cesiumStore = useCesiumStore();
const satStore = useSatStore();
const { showFps, requestRenderMode: renderOnDemand } = storeToRefs(cesiumStore);
/** Also installs `window.bench`. */
const bench = installBenchmark(cc);

/** `current` is the default: one pass rather than seven or eight. */
const MODES = [
  { value: "current", label: "current", hint: "Only the components currently switched on" },
  { value: "isolated", label: "isolated", hint: "Point, plus each other component on its own" },
  { value: "cumulative", label: "cumulative", hint: "One component added at a time, on top of the last" },
] as const;
type Mode = (typeof MODES)[number]["value"];

const countsText = ref(DEFAULT_SATELLITE_COUNTS.join(", "));
/** The clock axis multiplies the step count. */
const clocksText = ref("1");
const mode = ref<Mode>("current");
const warmupMs = ref(DEFAULT_OPTIONS.warmupMs);
const sampleMs = ref(DEFAULT_OPTIONS.sampleMs);
/** Below FPS_BAD a row is red, below FPS_WARN yellow. */
const FPS_BAD = 30;
const FPS_WARN = 60;

const withGroundStation = ref(false);
const withFootprint = ref(false);
const footprintAvailable = canMeasureFootprint();
const footprintHint = footprintAvailable
  ? "performance.measureUserAgentSpecificMemory(): an absolute footprint with garbage excluded, against the relative slope the default reports. It resolves only when a collection happens, which is the ~17 s."
  : "Unavailable: this page is not cross-origin isolated, so the API is not exposed. pnpm dev and pnpm preview send the headers that enable it; a deployed satvis.space does not.";
const running = ref(false);
const status = ref("idle");
const copied = ref("");
const settingsOpen = ref(true);
/**
 * The runner mutates its run in place, so a computed over `run` never
 * invalidates. Every derived view reads this counter instead.
 */
const revision = ref(0);
const finished = ref<BenchmarkRun | undefined>(undefined);

const counts = computed(() =>
  countsText.value
    .split(/[\s,]+/)
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isInteger(value) && value >= 0),
);

const componentSets = computed<readonly (readonly string[])[]>(() => {
  switch (mode.value) {
    case "cumulative":
      return CUMULATIVE_COMPONENT_SETS;
    case "current":
      return [[...satStore.enabledComponents]];
    default:
      return ISOLATED_COMPONENT_SETS;
  }
});

const clocks = computed(() =>
  clocksText.value
    .split(/[\s,x×]+/)
    .map((part) => Number.parseFloat(part))
    .filter((value) => Number.isFinite(value) && value > 0),
);

const spec = computed(() => ({ satelliteCounts: counts.value, componentSets: componentSets.value, clockMultipliers: clocks.value }));
const plan = computed(() => buildPlan(spec.value));

const estimateText = computed(() => {
  const seconds = Math.round(estimateDurationMs(plan.value, warmupMs.value + sampleMs.value, withFootprint.value ? FOOTPRINT_CAPTURE_MS : 0) / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
});

/** `mode` is recovered by comparing against the presets; anything else is "current". */
function adoptRunSettings(): void {
  const current = run();
  if (!current) {
    return;
  }
  const sameSets = (a: readonly (readonly string[])[], b: readonly (readonly string[])[]): boolean =>
    a.length === b.length && a.every((set, index) => set.join("|") === (b[index] ?? []).join("|"));
  const sets = current.spec.componentSets;
  mode.value = sameSets(sets, ISOLATED_COMPONENT_SETS) ? "isolated" : sameSets(sets, CUMULATIVE_COMPONENT_SETS) ? "cumulative" : "current";
  countsText.value = [...current.spec.satelliteCounts].join(", ");
  clocksText.value = (current.spec.clockMultipliers ?? [1]).join(", ");
  warmupMs.value = current.options.warmupMs;
  sampleMs.value = current.options.sampleMs;
  withFootprint.value = current.options.captureFootprint === true;
  withGroundStation.value = bench.target.options.groundStation !== undefined;
}

const settingsSummary = computed(() => {
  const parts = [`${counts.value.length} counts`, mode.value];
  if (clocks.value.length > 1 || (clocks.value[0] ?? 1) !== 1) {
    parts.push(`${clocks.value.length} clocks`);
  }
  if (withGroundStation.value) {
    parts.push("ground station");
  }
  if (withFootprint.value) {
    parts.push("footprint");
  }
  return `· ${parts.join(" · ")}`;
});

const run = (): BenchmarkRun | undefined => bench.runner.run ?? finished.value;

const rows = computed<ReportRow[]>(() => {
  void revision.value;
  const current = run();
  return current ? reportRows(current) : [];
});
const fits = computed<ScalingFit[]>(() => {
  void revision.value;
  const current = run();
  return current && current.results.length > 1 ? scalingFits(current) : [];
});
const memory = computed<MemoryFit[]>(() => {
  void revision.value;
  const current = run();
  return current && current.results.length > 1 ? memoryFits(current) : [];
});
const propagation = computed<PropagationCost[]>(() => {
  void revision.value;
  const current = run();
  return current ? propagationCosts(current) : [];
});
const repeats = computed<RepeatCheck[]>(() => {
  void revision.value;
  const current = run();
  return current ? repeatChecks(current) : [];
});

const signed = (percent: number): string => `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;

/** From the rows, not the form, so a console-started sweep shows it too. */
const clockSwept = computed(() => new Set(rows.value.map((row) => row.clock)).size > 1 || rows.value.some((row) => row.clock !== 1));

const thin = computed(() => rows.value.filter((row) => row.frames < MIN_TRUSTWORTHY_FRAMES).length);

/** The report blanks the whole column when the driver's clock is not believable. */
const gpuColumn = computed(() => rows.value.some((row) => row.gpuMs !== ""));

const footprintColumn = computed(() => {
  void revision.value;
  const current = run();
  return current !== undefined && hasFootprints(current);
});

interface Live {
  fps: number;
  frameMs: number;
  p95Ms: number;
  worstMs: number;
  cpuMs: number;
  /** Undefined without a GPU clock, or with one that contradicts the frame rate. */
  gpuMs: number | undefined;
  jankPct: number;
  /** The window's heap floor, not the live set. Undefined outside Chrome. */
  heapMb: number | undefined;
  satellites: number;
  components: string;
  clock: number;
  entities: number;
  primitives: number;
}
const EMPTY_LIVE: Live = {
  fps: 0,
  frameMs: 0,
  p95Ms: 0,
  worstMs: 0,
  cpuMs: 0,
  gpuMs: undefined,
  jankPct: 0,
  heapMb: undefined,
  satellites: 0,
  components: "",
  clock: 1,
  entities: 0,
  primitives: 0,
};
const live = ref<Live>(EMPTY_LIVE);

const fpsClass = computed(() => (live.value.fps < FPS_BAD ? "bench__bad" : live.value.fps < FPS_WARN ? "bench__warn" : "bench__good"));

const gpuOrUndefined = (gpuMs: number | undefined, wallP50: number | undefined): number | undefined =>
  gpuMs !== undefined && wallP50 !== undefined && wallP50 > 0 && gpuMs <= wallP50 * GPU_TIMER_TRUST_FACTOR ? gpuMs : undefined;

function disableRenderOnDemand(): void {
  cesiumStore.requestRenderMode = false;
}

let timer: ReturnType<typeof setInterval> | undefined;

function refresh(): void {
  // Read from the shared runner, so a console-started sweep fills the tables too.
  const wasRunning = running.value;
  running.value = bench.runner.running;
  if (!startedHere) {
    // A console run has no hooks here, so poll for its start and end.
    if (running.value) {
      status.value = "running — started from the console";
      adoptRunSettings();
    } else if (wasRunning) {
      const finishedRun = bench.runner.run;
      status.value = finishedRun ? `done — ${finishedRun.results.length} steps (console)` : "idle";
    }
  }
  revision.value += 1;
  const snapshot = bench.target.live();
  live.value = {
    fps: snapshot.frames.fps,
    frameMs: snapshot.frames.wall?.mean ?? 0,
    p95Ms: snapshot.frames.wall?.p95 ?? 0,
    worstMs: snapshot.frames.wall?.max ?? 0,
    cpuMs: snapshot.frames.cpu?.mean ?? 0,
    // The report's per-run GPU gate, applied per snapshot.
    gpuMs: gpuOrUndefined(snapshot.frames.gpu?.mean, snapshot.frames.wall?.p50),
    jankPct: snapshot.frames.jankRatio * 100,
    heapMb: snapshot.frames.heap?.min,
    satellites: snapshot.satellitesVisible,
    components: formatComponents(snapshot.componentsDrawn),
    clock: snapshot.clockMultiplier,
    entities: snapshot.entities,
    primitives: snapshot.primitives,
  };
}

/** Restored on close. Not the target's job: its save/restore is scoped to a run. */
let savedRequestRenderMode: boolean | undefined;

onMounted(() => {
  // Render-on-demand skips idle frames, so every figure would measure idleness.
  // Set through the store, not `scene.requestRenderMode`, so the Graphics panel's
  // switch follows.
  savedRequestRenderMode = cesiumStore.requestRenderMode;
  cesiumStore.requestRenderMode = false;
  refresh();
  // Rarely enough that reading it is not part of what is measured.
  timer = setInterval(refresh, 500);
});
onUnmounted(() => {
  if (timer !== undefined) {
    clearInterval(timer);
  }
  if (savedRequestRenderMode !== undefined) {
    cesiumStore.requestRenderMode = savedRequestRenderMode;
  }
});

let startedHere = false;

async function start(): Promise<void> {
  startedHere = true;
  running.value = true;
  finished.value = undefined;
  status.value = "preparing — loading the whole catalog";
  try {
    const result = await bench.runner.start(
      spec.value,
      { warmupMs: warmupMs.value, sampleMs: sampleMs.value, captureFootprint: withFootprint.value },
      {
        onProgress: ({ done, total, step }) => {
          status.value = `${done + 1}/${total} — ${step.label}`;
          revision.value += 1;
        },
        onResult: () => {
          revision.value += 1;
        },
      },
    );
    finished.value = result;
    status.value = result.cancelled ? `cancelled after ${result.results.length} steps` : `done — ${result.results.length} steps`;
    logRun(result);
  } catch (error) {
    status.value = `failed: ${String(error)}`;
  } finally {
    startedHere = false;
    running.value = false;
    revision.value += 1;
  }
}

function cancel(): void {
  bench.runner.cancel();
  status.value = "cancelling — finishing the current sample";
}

function logToConsole(): void {
  const current = run();
  if (current) {
    logRun(current);
    console.table(marginalCosts(current));
  }
}

async function copy(format: "csv" | "json" | "text"): Promise<void> {
  const current = run();
  if (!current) {
    return;
  }
  const text = format === "csv" ? toCsv(current) : format === "json" ? toJson(current) : formatTable(current);
  try {
    await navigator.clipboard.writeText(text);
    copied.value = `copied ${format}`;
  } catch {
    console.log(text);
    copied.value = "clipboard refused — logged instead";
  }
  setTimeout(() => {
    copied.value = "";
  }, 2000);
}

// On the shared target, because it belongs to the scene, not the sweep. Any location works.
watch(
  withGroundStation,
  (enabled) => {
    // Merged, so a console run's `tag` survives.
    bench.target.options = { ...bench.target.options, groundStation: enabled ? { lat: 48.1772, lon: 11.7476 } : undefined };
  },
  { immediate: true },
);
</script>

<style scoped>
/* The entity info panel's coordinates, so the two share one slot. */
.bench {
  position: fixed;
  top: 50px;
  right: 5px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  width: 480px;
  max-width: calc(100vw - 10px);
  max-height: calc(100dvh - 60px);
  border: 1px solid #ffb000;
  border-radius: 4px;
  background: rgba(12, 14, 18, 0.94);
  color: #d8dee9;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
}

/* Cesium's FPS counter sits at top 50px / right 10px; step below it while it is shown. */
.bench--below-fps {
  top: 110px;
  max-height: calc(100dvh - 120px);
}

/* Bar, alert and readout pinned; the body scrolls. The body needs `min-height: 0`
   to shrink, or the whole panel scrolls. */
.bench__bar,
.bench__alert,
.bench__live {
  flex: none;
}

.bench__alert {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: rgba(255, 176, 0, 0.15);
  border-bottom: 1px solid #ffb000;
  color: #ffb000;
}

.bench__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.bench__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: #ffb000;
  color: #16181d;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.bench__live {
  padding: 6px;
  border-bottom: 1px solid #2a2f3a;
}

/* `.bench .bench__x` to outrank the generic `.bench button` rule below. */
.bench .bench__x {
  margin-left: auto;
  padding: 0 2px;
  border: 0;
  border-radius: 2px;
  background: transparent;
  color: #16181d;
  cursor: pointer;
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
}

.bench .bench__x:hover {
  background: rgba(0, 0, 0, 0.25);
  color: #000;
}

.bench__block {
  padding: 6px;
  border-top: 1px solid #2a2f3a;
}

.bench__block--table {
  overflow-x: auto;
}

.bench__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.bench__row--big {
  font-size: 12px;
}

.bench__fps {
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
}

.bench__unit,
.bench__sep,
.bench__dim {
  color: #7a8291;
}

.bench__good {
  color: #86c06c;
}

.bench__warn {
  color: #ffb000;
}

.bench__bad {
  color: #f07178;
}

.bench__field {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.bench__field > span:first-child {
  width: 52px;
  flex: none;
  color: #7a8291;
}

.bench__modes,
.bench__inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.bench input[type="text"],
.bench input[type="number"] {
  border: 1px solid #2a2f3a;
  border-radius: 2px;
  background: #16181d;
  color: inherit;
  font: inherit;
  padding: 1px 4px;
}

.bench input[type="text"] {
  flex: 1;
  min-width: 0;
}

.bench input[type="number"] {
  width: 56px;
}

.bench button {
  border: 1px solid #3a4150;
  border-radius: 2px;
  background: #21252e;
  color: inherit;
  font: inherit;
  padding: 2px 8px;
  cursor: pointer;
}

.bench button:disabled {
  opacity: 0.4;
  cursor: default;
}

.bench__run {
  border-color: #ffb000;
  color: #ffb000;
}

.bench__table {
  width: 100%;
  border-collapse: collapse;
  white-space: nowrap;
}

.bench__table th {
  color: #7a8291;
  font-weight: 400;
  text-align: left;
  border-bottom: 1px solid #2a2f3a;
}

.bench__table td,
.bench__table th {
  padding: 0 4px;
}

.bench__table tbody tr:nth-child(even) {
  background: rgba(255, 255, 255, 0.03);
}

.bench__thin td {
  color: #6b7280;
  text-decoration: line-through;
}

/* Outranks `.bench__table th`, which sets text-align: left. */
.bench__table th.bench__num {
  text-align: right;
}
.bench__num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.bench__caption {
  color: #7a8291;
  margin-bottom: 2px;
}

/* The whole header row is the hit target. Outranks `.bench button`. */
.bench .bench__fold {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-bottom: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #7a8291;
  text-align: left;
}

.bench .bench__fold:hover {
  color: #d8dee9;
}

.bench__chevron {
  width: 8px;
}
</style>
