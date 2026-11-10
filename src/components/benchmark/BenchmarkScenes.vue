<!--
  The preset's benchmark scenes (ADR 0016): each a row from the start, ticked to run, filled as it
  is measured, and opened in place for the rest of its figures.
-->
<template>
  <div class="bench__section">
    <div class="bench__scene-table bench__table-scroll">
      <table class="bench__table">
        <thead>
          <tr>
            <th class="bench__check">
              <input
                type="checkbox"
                aria-label="All scenes"
                :checked="allSelected"
                :indeterminate="someSelected && !allSelected"
                :disabled="panel.running.value || panel.scenes.value.length === 0"
                @change="selectAll(!allSelected)"
              />
            </th>
            <th>Scene</th>
            <th class="bench__num">fps</th>
            <th class="bench__num">CPU</th>
            <th class="bench__num">GPU</th>
            <th class="bench__num" title="The busier side's share of the time; at least the CPU's where the GPU's is unknown">Load</th>
            <th class="bench__num" title="Chrome's JS heap, garbage included: not the native app's footprint">heap</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in rows" :key="row.id">
            <tr
              :class="{ 'bench__scene--current': row.current, 'bench__scene--open': expanded === row.id, 'bench__scene--measured': row.result }"
              :aria-expanded="row.result ? expanded === row.id : undefined"
              @click="toggle(row)"
            >
              <td class="bench__check" @click.stop>
                <input
                  v-if="!row.repeat"
                  type="checkbox"
                  :aria-label="row.name"
                  :checked="panel.selected.value.includes(row.id)"
                  :disabled="panel.running.value"
                  @change="select(row.id)"
                />
              </td>
              <td class="bench__scene-name">
                <div>{{ row.name }}</div>
                <div :class="['bench__scene-sub', row.result?.timedOut ? 'bench__warn' : '']">{{ row.subtitle }}</div>
              </td>
              <td class="bench__num">{{ fixed(row.result?.summary.fps, 1) }}</td>
              <td class="bench__num">{{ fixed(row.result?.summary.cpuMs, 1) }}</td>
              <td class="bench__num">{{ fixed(row.result?.summary.gpuMs, 1) }}</td>
              <td class="bench__num">{{ loadOf(row.result) }}</td>
              <td class="bench__num">{{ fixed(row.result?.memoryMb, 0) }}</td>
            </tr>
            <tr v-if="row.result && expanded === row.id" class="bench__scene-detail">
              <td />
              <td colspan="6">
                <dl class="bench__details">
                  <template v-for="detail in details(row.result)" :key="detail.label">
                    <dt>{{ detail.label }}</dt>
                    <dd class="bench__num">{{ detail.value }}</dd>
                  </template>
                </dl>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p class="bench__caption">Each scene is loaded, settled for 3 s and measured for 5 s. Times in ms a frame, load in % busy, the heap in MB.</p>
  </div>
  <div class="bench__section bench__actions">
    <button v-if="panel.running.value" type="button" class="bench__button" @click="panel.cancel()">Cancel</button>
    <button v-else type="button" class="bench__button bench__button--primary" :disabled="panel.sceneSteps.value.length === 0" @click="void panel.startScenes()">
      {{ runLabel }}
    </button>
    <!-- Sent only on a tap, never by a run a link started. -->
    <button type="button" class="bench__button" :disabled="!sendable" @click="panel.send()">{{ panel.sent.value ? "Sent" : "Send results" }}</button>
    <button type="button" class="bench__button" :disabled="!panel.report.value" @click="void copyReport()">Copy report</button>
    <p class="bench__caption bench__actions-caption">{{ copied || sendCaption }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

import { formatLoad, phaseLabel, type SceneResult, sceneResults } from "@/modules/benchmark";
import { formatFixed, formatInteger } from "@/modules/util/formats";

import { useBenchmarkPanel } from "./benchmarkPanel";
import { copyText } from "./copyText";

interface SceneRow {
  id: string;
  name: string;
  repeat: boolean;
  result: SceneResult | undefined;
  current: boolean;
  subtitle: string;
}

const panel = useBenchmarkPanel();
/** One row open at a time. */
const expanded = ref<string>();
const copied = ref("");

const allSelected = computed(() => panel.scenes.value.length > 0 && panel.selected.value.length === panel.scenes.value.length);
const someSelected = computed(() => panel.selected.value.length > 0);

const runLabel = computed(() => {
  const count = panel.sceneSteps.value.length;
  return `Run ${count} ${count === 1 ? "scene" : "scenes"}`;
});

const rows = computed<SceneRow[]>(() => {
  // The run is filled in place, so it never reads as changed.
  void panel.revision.value;
  const run = panel.sceneRun.value;
  const results = new Map(run ? sceneResults(run).map((result) => [result.id, result]) : []);
  const progress = panel.bench.runner.progress;
  const currentId = progress?.kind === "scenes" ? run?.steps[progress.index]?.id : undefined;
  const repeat = run?.steps.find((step) => step.repeat);
  const listed = [
    ...panel.scenes.value.map((scene) => ({ id: scene.id, name: scene.name, repeat: false })),
    ...(repeat ? [{ id: repeat.id, name: repeat.label, repeat: true }] : []),
  ];
  return listed.map(({ id, name, repeat: isRepeat }) => {
    const result = results.get(id);
    const current = id === currentId && progress !== undefined;
    const subtitle = current
      ? `${phaseLabel(progress.phase, "scenes")}…`
      : [result ? `${formatInteger(result.satellites)} satellites` : undefined, result?.timedOut ? "timed out" : undefined].filter(Boolean).join(" · ");
    return { id, name, repeat: isRepeat, result, current, subtitle };
  });
});

const cancelled = computed(() => panel.report.value?.benchmark_cancelled === true);
const sendable = computed(() => panel.report.value !== undefined && !cancelled.value && !panel.sent.value && panel.analyticsOn && !panel.running.value);
const sendCaption = computed(() => {
  if (panel.sent.value) {
    return "Sent, with the device and build they depend on.";
  }
  if (!panel.analyticsOn) {
    return "Usage is not counted here, so there is nowhere to send results.";
  }
  if (cancelled.value) {
    return "A cancelled run is kept to read, not sent.";
  }
  return panel.report.value ? "Sends the results with the device and build they depend on." : "Run the scenes to send their results.";
});

/** A number to `digits` places, or a dash for none. */
const fixed = (value: number | null | undefined, digits: number): string =>
  value === null || value === undefined ? "–" : digits === 0 ? formatInteger(value) : formatFixed(value, digits);
/** A whole percent, or a dash for none. */
const percent = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : `${formatInteger(value)} %`);

/** A row's load, a dash before it is measured. */
function loadOf(result: SceneResult | undefined): string {
  return result ? formatLoad(result.summary.loadPct, result.summary.cpuBusyPct, " %") : "–";
}

/** Everything the row does not show, the app's own figures last. */
function details(result: SceneResult): { label: string; value: string }[] {
  const { summary } = result;
  return [
    { label: "p95 CPU", value: `${fixed(summary.cpuP95Ms, 1)} ms` },
    { label: "p95 GPU", value: `${fixed(summary.gpuP95Ms, 1)} ms` },
    { label: "over budget", value: percent(summary.overBudgetPct) },
    // A floor here: the frames and what the workers report, not the process's time.
    { label: "total CPU", value: summary.cpuTotalPct === null ? "–" : `≥ ${percent(summary.cpuTotalPct)}` },
    { label: "frames", value: formatInteger(summary.frames) },
    { label: "load time", value: `${fixed(result.loadSeconds, 1)} s` },
    ...Object.entries(result.extras).map(([name, value]) => ({ label: `x_${name}`, value: fixed(value, 2) })),
  ];
}

/** Expands a measured row, folding the one open. */
function toggle(row: SceneRow): void {
  if (row.result) {
    expanded.value = expanded.value === row.id ? undefined : row.id;
  }
}

/** Ticks or unticks a scene. */
function select(id: string): void {
  const selected = panel.selected.value;
  // In the served order, which a run takes them in.
  const next = selected.includes(id) ? selected.filter((other) => other !== id) : [...selected, id];
  panel.selected.value = panel.scenes.value.map((scene) => scene.id).filter((other) => next.includes(other));
}

/** Ticks every scene, or none. */
function selectAll(all: boolean): void {
  panel.selected.value = all ? panel.scenes.value.map((scene) => scene.id) : [];
}

/** Copies the report as JSON, and says so for two seconds. */
async function copyReport(): Promise<void> {
  copied.value = await copyText(JSON.stringify(panel.report.value, null, 2), "report");
  setTimeout(() => {
    copied.value = "";
  }, 2000);
}
</script>

<style>
.bench__check {
  width: 18px;
  padding-right: 0 !important;
}

.bench__scene-name {
  white-space: normal;
}

.bench__scene-sub {
  color: var(--bench-dim);
  font-size: 11px;
}

.bench__scene--measured {
  cursor: pointer;
}

.bench__table tbody tr.bench__scene--current {
  background: rgba(87, 196, 180, 0.14);
}

.bench__table tbody tr.bench__scene--open,
.bench__table tbody tr.bench__scene-detail {
  background: rgba(255, 255, 255, 0.06);
}

.bench__details {
  display: grid;
  grid-template-columns: repeat(4, auto 1fr);
  gap: 1px 8px;
  margin: 0 0 4px;
}

@media (max-width: 420px) {
  .bench__details {
    grid-template-columns: repeat(2, auto 1fr);
  }
}

.bench__details dt {
  color: var(--bench-dim);
}

.bench__details dd {
  margin: 0;
}

.bench__actions-caption {
  flex-basis: 100%;
  margin: 0;
}
</style>
