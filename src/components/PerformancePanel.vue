<!--
  The performance panel (`fps`, ADR 0016): what a frame costs, averaged over half a second,
  and on a tap the last five seconds frame by frame. The native app's PerformanceOverlay shows
  the same. It never changes render pacing, and reads the same figures paced or not: each
  frame's work against the frame budget, as the gaps between paced frames are idle by design.
  Idle, GPU time reads at the GPU's lowered clock, marked and left out of the budget.
-->
<template>
  <button type="button" class="perf" :class="{ 'perf--expanded': expanded }" :aria-expanded="expanded" aria-label="Performance" @click="toggle">
    <span class="perf__fps">{{ fpsText }}</span>
    <span>CPU {{ ms(stats?.cpuMs) }} · GPU {{ ms(stats?.gpuMs) }}{{ stats?.idle && stats.gpuMs !== null ? " (idle)" : "" }}</span>
    <span>Load {{ loadText }} · {{ memoryText }} · {{ satellitesText }}</span>
    <template v-if="expanded">
      <canvas ref="canvas" class="perf__graph" :width="GRAPH_WIDTH * pixelRatio" :height="GRAPH_HEIGHT * pixelRatio" />
      <span class="perf__legend">
        <span><i class="perf__key perf__key--cpu" />CPU</span>
        <span><i class="perf__key perf__key--gpu" />GPU</span>
        <span><i class="perf__key perf__key--budget" />{{ formatFixed(graph.budgetMs, 1) }} ms budget</span>
      </span>
      <span>p95 CPU {{ ms(graph.cpuP95Ms) }} · GPU {{ ms(graph.gpuP95Ms) }}</span>
      <span>over budget {{ percent(graph.overBudgetPct) }} · total CPU {{ floor(stats?.cpuTotalPct) }}</span>
    </template>
  </button>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import { useController } from "@/composables/useController";
import { frameMeterFor, GRAPH_WINDOW_MS, type LiveFrameStats, type MeteredFrame } from "@/modules/benchmark/frameMeter";
import { overBudgetPct, percentile } from "@/modules/benchmark/frameSummary";
import { formatFixed, formatInteger } from "@/modules/util/formats";
import { useCesiumStore } from "@/stores/cesium";

/** CSS pixels. */
const GRAPH_WIDTH = 240;
const GRAPH_HEIGHT = 72;
/** The y axis runs to the longest frame, between these many frame budgets; longer work is clipped and marked. */
const GRAPH_FLOOR = 1.25;
const GRAPH_CEILING = 3;
/** Ten times a second: smooth enough, and a fraction of a frame's cost. */
const GRAPH_REDRAW_MS = 100;
const USER = "performance-panel";
/** CSS pixels: wide enough to see at a few frames a second. */
const MAX_BAR_WIDTH = 2;
const OVER_COLOUR = "#e5534b";
const CPU_COLOUR = "#57c4b4";
const GPU_COLOUR = "#d58cf0";

const cc = useController();
const meter = frameMeterFor(cc.viewer, () => cc.sats.visibleSatellites.length);
const { fpsPanel, frameRate } = storeToRefs(useCesiumStore());

const expanded = computed(() => fpsPanel.value === "graph");
const stats = shallowRef<LiveFrameStats>();
const canvas = ref<HTMLCanvasElement>();
const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
/** Over the graph's five seconds. */
const graph = ref<{ budgetMs: number; cpuP95Ms: number | null; gpuP95Ms: number | null; overBudgetPct: number | null }>({
  budgetMs: 1000 / 60,
  cpuP95Ms: null,
  gpuP95Ms: null,
  overBudgetPct: null,
});

const ms = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : `${formatFixed(value, 1)} ms`);
const percent = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : `${formatFixed(value, 0)} %`);

const fpsText = computed(() => {
  const value = stats.value;
  if (!value) {
    return "– fps";
  }
  return `${formatInteger(value.fps ?? 0)} fps${value.paced ? " · paced" : ""}`;
});
/** The CPU's side alone is a floor where the GPU's is unknown, as in Safari. */
const loadText = computed(() => {
  const value = stats.value;
  if (!value) {
    return "–";
  }
  return value.loadPct === null ? `≥ ${percent(value.cpuBusyPct)}` : percent(value.loadPct);
});
/** Chrome's JS heap, garbage included: not the native app's footprint, so named. */
const memoryText = computed(() => (stats.value?.memoryMb === null || stats.value?.memoryMb === undefined ? "– MB" : `${formatInteger(stats.value.memoryMb)} MB heap`));
/** Total CPU on the web is a floor: frames and what the workers report, not the process's. */
const floor = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : `≥ ${percent(value)}`);
const satellitesText = computed(() => `${formatInteger(stats.value?.satellites ?? 0)} sats`);

function toggle(): void {
  fpsPanel.value = expanded.value ? "true" : "graph";
}

/**
 * Each frame where it was drawn, as a bar of its CPU time with its GPU time marked, against
 * the budget the frame rate allows. Paced or not alike: a paced scene shows few bars, and a
 * hitch shows as a gap.
 */
function draw(): void {
  const context = canvas.value?.getContext("2d");
  if (!context) {
    return;
  }
  const now = performance.now();
  const budget = meter.refreshMs(frameRate.value);
  // The meter prunes only as a frame is drawn: paced and paused, nothing is, for longer than the window.
  const frames = meter.frames.filter((frame) => frame.at >= now - GRAPH_WINDOW_MS);
  const gpu = frames.flatMap((frame) => (frame.gpuMs === undefined ? [] : [frame.gpuMs]));
  const cpu = frames.map((frame) => frame.cpuMs);
  const work = (frame: MeteredFrame): number => Math.max(frame.cpuMs, frame.gpuMs ?? 0);
  const ceiling = Math.min(budget * GRAPH_CEILING, Math.max(budget * GRAPH_FLOOR, ...frames.map(work)));
  // As a benchmark step reports them (`summarize`).
  graph.value = {
    budgetMs: budget,
    cpuP95Ms: percentile(cpu, 0.95),
    gpuP95Ms: percentile(gpu, 0.95),
    overBudgetPct: overBudgetPct(cpu, stats.value?.idle ? [] : gpu, budget),
  };

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, GRAPH_WIDTH, GRAPH_HEIGHT);
  const x = (at: number): number => GRAPH_WIDTH - ((now - at) / GRAPH_WINDOW_MS) * GRAPH_WIDTH;
  const y = (value: number): number => GRAPH_HEIGHT - (Math.min(value, ceiling) / ceiling) * GRAPH_HEIGHT;
  context.strokeStyle = "rgba(255, 255, 255, 0.55)";
  context.setLineDash([3, 3]);
  context.beginPath();
  context.moveTo(0, y(budget) + 0.5);
  context.lineTo(GRAPH_WIDTH, y(budget) + 0.5);
  context.stroke();
  context.setLineDash([]);
  // The lines below cover this window, the header only its last half second.
  context.font = "9px ui-monospace, Menlo, monospace";
  context.fillStyle = "rgba(255, 255, 255, 0.6)";
  context.fillText(`last ${GRAPH_WINDOW_MS / 1000} s`, 2, 10);
  let previous: number | undefined;
  for (const frame of frames) {
    const right = x(frame.at);
    // Touching its neighbour at full rate, a thin bar where frames are few.
    const width = Math.min(MAX_BAR_WIDTH, Math.max(1, previous === undefined ? MAX_BAR_WIDTH : right - previous));
    previous = right;
    context.fillStyle = CPU_COLOUR;
    context.fillRect(right - width, y(frame.cpuMs), width, GRAPH_HEIGHT - y(frame.cpuMs));
    if (frame.gpuMs !== undefined) {
      context.fillStyle = GPU_COLOUR;
      context.fillRect(right - width, y(frame.gpuMs) - 1, width, 2);
    }
    if (work(frame) > ceiling) {
      context.fillStyle = OVER_COLOUR;
      context.fillRect(right - width, 0, width, 3);
    }
  }
}

let statsTimer: ReturnType<typeof setInterval> | undefined;
let graphTimer: ReturnType<typeof setInterval> | undefined;

watch(
  expanded,
  (open) => {
    clearInterval(graphTimer);
    graphTimer = open ? setInterval(draw, GRAPH_REDRAW_MS) : undefined;
  },
  { immediate: true },
);

onMounted(() => {
  meter.acquire(USER);
  statsTimer = setInterval(() => {
    stats.value = meter.stats;
  }, 500);
});

onBeforeUnmount(() => {
  clearInterval(statsTimer);
  clearInterval(graphTimer);
  meter.release(USER);
});
</script>

<style scoped>
.perf {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 5px 9px;
  border: none;
  border-radius: 8px;
  background: rgba(12, 14, 18, 0.82);
  color: #fff;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
  text-align: left;
  cursor: pointer;
}

.perf__fps {
  font-weight: 600;
}

.perf__legend {
  display: flex;
  gap: 8px;
  color: rgba(255, 255, 255, 0.7);
}

.perf__legend > span {
  display: flex;
  align-items: center;
  gap: 3px;
}

.perf__key {
  display: inline-block;
  width: 7px;
  height: 7px;
}

.perf__key--cpu {
  background: #57c4b4;
}

.perf__key--gpu {
  height: 2px;
  background: #d58cf0;
}

.perf__key--budget {
  width: 9px;
  height: 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.55);
}

/* At least as wide as the graph; a long line of large figures widens it. */
.perf--expanded {
  min-width: calc(240px + 18px);
}

.perf__graph {
  width: 240px;
  height: 72px;
  margin: 4px 0 2px;
}
</style>
