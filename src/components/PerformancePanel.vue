<!--
  The performance panel (`fps`, ADR 0016): what a frame costs, averaged over half a second,
  and on a tap the last five seconds frame by frame. It never changes render pacing, and reads
  the same figures paced or not: each frame's work against the frame budget, as the gaps
  between paced frames are idle by design. Idle, GPU time reads at the GPU's lowered clock,
  marked and left out of the budget. Both widths are fixed, so changing figures never move it.
-->
<template>
  <button type="button" class="perf" :class="{ 'perf--expanded': expanded }" :aria-expanded="expanded" aria-label="Performance" @click="toggle">
    <span class="perf__head">
      <i class="perf__dot" :style="{ background: severity(loadShare) }" />
      <span class="perf__fps">{{ fpsText }}</span>
      <span class="perf__stack">
        <span>fps</span>
        <span>{{ stalledMs !== null ? "no frames" : stats?.paced ? "paced" : " " }}</span>
      </span>
      <span class="perf__stack perf__stack--end">
        <span>{{ memoryText }}</span>
        <span>{{ formatInteger(stats?.satellites ?? 0) }} sats</span>
      </span>
    </span>
    <span class="perf__rows">
      <template v-for="meter in meters" :key="meter.label">
        <span class="perf__label">{{ meter.label }}</span>
        <span class="perf__track" :class="{ 'perf__track--idle': meter.idle }">
          <i class="perf__fill" :style="{ width: `${Math.min(meter.fill, 1) * 100}%`, background: meter.colour, opacity: meter.idle ? 0.5 : 1 }" />
          <i v-if="meter.budget" class="perf__tick" />
        </span>
        <span class="perf__value" :title="meter.title">{{ meter.value }}</span>
        <span class="perf__unit">{{ meter.unit }}</span>
      </template>
      <template v-if="expanded">
        <canvas ref="canvas" class="perf__graph" />
        <span class="perf__section">last {{ GRAPH_WINDOW_MS / 1000 }} s · frames by share of budget</span>
        <template v-for="side in splits" :key="side.label">
          <span class="perf__label">{{ side.label }}</span>
          <span class="perf__split" :class="{ 'perf__split--idle': side.idle }" :title="side.title">
            <i v-for="part in side.parts" :key="part.key" :style="{ flexGrow: part.share, background: part.colour }" />
          </span>
          <span class="perf__value perf__value--small" :title="side.p95Title">{{ side.p95Text }}</span>
          <span class="perf__unit">p95</span>
        </template>
      </template>
    </span>
    <span v-if="expanded" class="perf__foot">
      <span
        >{{ graph.gpuIdle ? "over, CPU" : "over budget" }}
        <b :style="{ color: (graph.overBudgetPct ?? 0) > 0 ? OVER_COLOUR : undefined }">{{ overPercent(graph.overBudgetPct) }}</b></span
      >
      <span
        >total CPU <b>{{ floor(live?.cpuTotalPct) }}</b></span
      >
    </span>
  </button>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";

import { useController } from "@/composables/useController";
import { frameMeterFor, gpuCapMs, gpuCappedPct, GRAPH_WINDOW_MS, type LiveFrameStats, type MeteredFrame } from "@/modules/benchmark/frameMeter";
import { formatLoad, overBudgetPct, percentile } from "@/modules/benchmark/frameSummary";
import { formatFixed, formatInteger } from "@/modules/util/formats";
import { useCesiumStore } from "@/stores/cesium";

/** CSS pixels. */
const GRAPH_HEIGHT = 84;
/** Room above the bars for the legend. */
const GRAPH_TOP = 12;
/** The y axis runs to the longest frame, between these many frame budgets; longer work is clipped and marked. */
const GRAPH_FLOOR = 1.25;
const GRAPH_CEILING = 3;
/** The CPU and GPU meters run to this many budgets, so the budget's tick sits at two thirds. */
const METER_SCALE = 1.5;
/** Ten times a second: smooth enough, and a fraction of a frame's cost. */
const GRAPH_REDRAW_MS = 100;
const USER = "performance-panel";
const OVER_COLOUR = "#e5534b";
const WARN_COLOUR = "#e0b341";
const CPU_COLOUR = "#57c4b4";
const GPU_COLOUR = "#d58cf0";
/**
 * Paced at ×1 the default view draws about four frames a second; none for this long, as with
 * the clock paused, reads as no frames rather than the last half second's figures.
 */
const STALL_MS = 2000;

const cc = useController();
const meter = frameMeterFor(cc.viewer, () => cc.sats.visibleSatellites.length);
const { fpsPanel, frameRate } = storeToRefs(useCesiumStore());

const expanded = computed(() => fpsPanel.value === "graph");
const stats = shallowRef<LiveFrameStats>();
/** How long since the last drawn frame, once past `STALL_MS`; null while frames come. */
const stalledMs = ref<number | null>(null);
/** The frame figures, none while no frame is drawn: the last ones would stand for nothing. */
const live = computed(() => (stalledMs.value === null ? stats.value : undefined));
const fpsText = computed(() => {
  if (stalledMs.value !== null) {
    return "0";
  }
  return stats.value?.fps === null || stats.value?.fps === undefined ? "–" : formatInteger(stats.value.fps);
});
const canvas = ref<HTMLCanvasElement>();
/** The frames drawn over the graph's five seconds, ten times a second while expanded. */
const recent = shallowRef<{ now: number; frames: readonly MeteredFrame[] }>({ now: 0, frames: [] });
/** Over the graph's five seconds. */
const graph = ref<{ cpuP95Ms: number | null; gpuP95Ms: number | null; overBudgetPct: number | null; gpu: number[]; gpuIdle: boolean; gpuCapped: boolean }>({
  cpuP95Ms: null,
  gpuP95Ms: null,
  overBudgetPct: null,
  gpu: [],
  gpuIdle: false,
  gpuCapped: false,
});

/** A number to `digits` places, or a dash for none. */
const number = (value: number | null | undefined, digits: number): string => (value === null || value === undefined ? "–" : formatFixed(value, digits));
/** A whole percent, or a dash for none. */
const percent = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : `${formatFixed(value, 0)} %`);
/** A share that rounds to 0 % but is not, which the colour marks, reads as under 1 %. */
const overPercent = (value: number | null | undefined): string => (value !== null && value !== undefined && value > 0 && value < 0.5 ? "< 1 %" : percent(value));
/**
 * Past it, most GPU times were capped at the frame interval, so the figure is a ceiling: a GPU
 * busy all frame spent the interval on it, at the clock it ran, and one clocked down to fill a
 * capped frame rate needs less at full clock (16.6 ms at 60 fps for 13 ms uncapped).
 */
const MOSTLY_CAPPED_PCT = 50;
/** Why a capped GPU figure reads "≤". */
const CAPPED_TITLE = "Busy the whole frame: capped at the frame interval, as the GPU timer counts queueing once saturated. At full clock it may need less";
/** A time to one place, marked "≤" and titled where it is mostly capped. */
const timeFigure = (value: number | null | undefined, capped: boolean): { text: string; title: string | undefined } =>
  capped && value !== null && value !== undefined ? { text: `≤${number(value, 1)}`, title: CAPPED_TITLE } : { text: number(value, 1), title: undefined };
/** Total CPU on the web is a floor: frames and what the workers report, not the process's. */
const floor = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : `≥ ${percent(value)}`);
/** Chrome's JS heap, garbage included: not the native app's footprint, so named. */
const memoryText = computed(() => (stats.value?.memoryMb === null || stats.value?.memoryMb === undefined ? "– MB heap" : `${formatInteger(stats.value.memoryMb)} MB heap`));

/** The frame budget at the chosen frame rate, in milliseconds. */
const budgetMs = (): number => meter.refreshMs(frameRate.value);
/** Load, or the CPU's side alone where the GPU's is unknown, as a share. */
const loadShare = computed(() => {
  const load = live.value?.loadPct ?? live.value?.cpuBusyPct;
  return load === null || load === undefined ? null : load / 100;
});

/** Green, amber, red by share of the budget or of the device. */
function severity(share: number | null): string {
  if (share === null) {
    return "rgba(255, 255, 255, 0.5)";
  }
  if (share < 0.6) {
    return CPU_COLOUR;
  }
  return share < 0.9 ? WARN_COLOUR : OVER_COLOUR;
}

/** CPU and GPU against the budget, in the graph's colours and red over it; load against the device. */
const meters = computed(() => {
  const value = live.value;
  const budget = budgetMs();
  const idle = Boolean(value?.idle && value.gpuMs !== null);
  const capped = !idle && (value?.gpuCappedPct ?? 0) > MOSTLY_CAPPED_PCT;
  const gpu = timeFigure(value?.gpuMs, capped);
  const side = (label: string, ms: number | null | undefined, colour: string, isIdle: boolean) => {
    const share = ms === null || ms === undefined ? 0 : ms / budget;
    return { label, value: number(ms, 1), fill: share / METER_SCALE, colour: share > 1 && !isIdle ? OVER_COLOUR : colour, budget: true, idle: isIdle, title: undefined };
  };
  return [
    { ...side("CPU", value?.cpuMs, CPU_COLOUR, false), unit: "ms" },
    {
      ...side("GPU", value?.gpuMs, GPU_COLOUR, idle),
      value: gpu.text,
      title: gpu.title,
      unit: idle ? "idle" : "ms",
    },
    {
      label: "Load",
      unit: "%",
      value: formatLoad(value?.loadPct ?? null, value?.cpuBusyPct ?? null),
      fill: loadShare.value ?? 0,
      colour: severity(loadShare.value),
      budget: false,
      idle: false,
      title: undefined,
    },
  ];
});

/** Each side's frames by share of the budget, counted on its own as `overBudgetPct` does, so the red share is over budget. */
const splits = computed(() => {
  const budget = budgetMs();
  const { frames } = recent.value;
  const split = (label: string, values: number[], colour: string, p95: number | null, isIdle: boolean, capped = false) => {
    const total = Math.max(values.length, 1);
    const share = (test: (value: number) => boolean): number => values.filter(test).length / total;
    const parts = [
      { key: "half", share: share((value) => value <= budget / 2), colour },
      { key: "full", share: share((value) => value > budget / 2 && value <= budget), colour },
      { key: "over", share: share((value) => value > budget), colour: isIdle ? colour : OVER_COLOUR },
    ];
    const [half, full, over] = parts.map((part) => percent(part.share * 100));
    const p95Figure = timeFigure(p95, capped);
    return {
      label,
      parts,
      p95Text: p95Figure.text,
      p95Title: p95Figure.title,
      idle: isIdle,
      title: `≤ ½ budget ${half}, ≤ budget ${full}, over ${over}`,
    };
  };
  return [
    split(
      "CPU",
      frames.map((frame) => frame.cpuMs),
      CPU_COLOUR,
      graph.value.cpuP95Ms,
      false,
    ),
    split("GPU", graph.value.gpu, GPU_COLOUR, graph.value.gpuP95Ms, graph.value.gpuIdle, graph.value.gpuCapped),
  ];
});

/** Switches between the compact and the graph view. */
function toggle(): void {
  fpsPanel.value = expanded.value ? "true" : "graph";
}

/** Reads the graph's frames and figures from the meter, then draws them. */
function sample(): void {
  const now = performance.now();
  // The meter prunes only as a frame is drawn: paced and paused, nothing is, for longer than the window.
  const drawn = meter.frames.filter((frame) => frame.at >= now - GRAPH_WINDOW_MS);
  // Capped as the meter caps a recording's.
  const timed = drawn.flatMap((frame) => (frame.gpuMs === undefined || frame.idle ? [] : [frame.gpuMs]));
  const intervals = drawn.slice(1).map((frame, i) => frame.at - (drawn[i] as MeteredFrame).at);
  const cap = gpuCapMs(timed, intervals);
  const frames = drawn.map(({ at, cpuMs, gpuMs, idle }) => ({ at, cpuMs, gpuMs: gpuMs === undefined ? undefined : Math.min(gpuMs, cap), idle }));
  const cpu = frames.map((frame) => frame.cpuMs);
  const gpuOf = (idle: boolean): number[] => frames.flatMap((frame) => (frame.gpuMs === undefined || frame.idle !== idle ? [] : [frame.gpuMs]));
  // Idle frames' GPU times stand in only where no other frame was timed, and never count against the budget.
  const busy = gpuOf(false);
  const gpu = busy.length > 0 ? busy : gpuOf(true);
  // As a benchmark step reports them (`summarize`).
  graph.value = {
    cpuP95Ms: percentile(cpu, 0.95),
    gpuP95Ms: percentile(gpu, 0.95),
    overBudgetPct: overBudgetPct(cpu, busy, budgetMs()),
    gpu,
    gpuIdle: busy.length === 0 && gpu.length > 0,
    gpuCapped: (gpuCappedPct(timed, intervals) ?? 0) > MOSTLY_CAPPED_PCT,
  };
  recent.value = { now, frames };
  draw();
}

/**
 * Each frame where it was drawn: a bar of its CPU time over a pale column of its GPU time,
 * capped, so the GPU's height reads under a taller CPU bar. Paced or not alike: a paced
 * scene shows few bars, and a hitch shows as a gap. The p95s are marked at the right.
 */
function draw(): void {
  const element = canvas.value;
  const context = element?.getContext("2d");
  const width = element?.clientWidth ?? 0;
  if (!element || !context || width === 0) {
    return;
  }
  const height = GRAPH_HEIGHT;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (element.width !== width * ratio || element.height !== height * ratio) {
    element.width = width * ratio;
    element.height = height * ratio;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const budget = budgetMs();
  const { now, frames } = recent.value;
  const work = (frame: MeteredFrame): number => Math.max(frame.cpuMs, frame.gpuMs ?? 0);
  const ceiling = Math.min(budget * GRAPH_CEILING, Math.max(budget * GRAPH_FLOOR, ...frames.map(work)));
  const y = (value: number): number => height - (Math.min(value, ceiling) / ceiling) * (height - GRAPH_TOP);
  for (const frame of frames) {
    const x = width - ((now - frame.at) / GRAPH_WINDOW_MS) * width;
    if (frame.gpuMs !== undefined) {
      context.fillStyle = GPU_COLOUR;
      context.globalAlpha = frame.idle ? 0.15 : 0.35;
      context.fillRect(x - 3, y(frame.gpuMs), 3, height - y(frame.gpuMs));
      context.globalAlpha = frame.idle ? 0.5 : 1;
      context.fillStyle = frame.gpuMs > budget && !frame.idle ? OVER_COLOUR : GPU_COLOUR;
      context.fillRect(x - 3, y(frame.gpuMs) - 1, 3, 2);
      context.globalAlpha = 1;
    }
    context.fillStyle = frame.cpuMs > budget ? OVER_COLOUR : CPU_COLOUR;
    context.fillRect(x - 2, y(frame.cpuMs), 1.5, height - y(frame.cpuMs));
    if (work(frame) > ceiling) {
      context.fillStyle = OVER_COLOUR;
      context.fillRect(x - 3, GRAPH_TOP - 3, 3, 3);
    }
  }

  context.strokeStyle = "rgba(255, 255, 255, 0.55)";
  context.lineWidth = 1;
  context.setLineDash([3, 3]);
  context.beginPath();
  context.moveTo(0, y(budget) + 0.5);
  context.lineTo(width, y(budget) + 0.5);
  context.stroke();
  context.setLineDash([]);
  context.lineWidth = 1.5;
  for (const [p95, colour] of [
    [graph.value.cpuP95Ms, CPU_COLOUR],
    [graph.value.gpuP95Ms, GPU_COLOUR],
  ] as const) {
    if (p95 !== null) {
      context.strokeStyle = colour;
      context.beginPath();
      context.moveTo(width - 10, y(p95));
      context.lineTo(width, y(p95));
      context.stroke();
    }
  }

  context.font = "9px ui-monospace, Menlo, monospace";
  const budgetLabel = `${formatFixed(budget, 1)} ms`;
  context.fillStyle = "rgba(12, 14, 18, 0.85)";
  context.fillRect(0, y(budget) - 11, context.measureText(budgetLabel).width + 4, 10);
  context.fillStyle = "rgba(255, 255, 255, 0.75)";
  context.fillText(budgetLabel, 1, y(budget) - 3);
  context.fillStyle = CPU_COLOUR;
  context.fillRect(0, 1, 2, 7);
  context.fillText("CPU", 5, 8);
  context.fillStyle = GPU_COLOUR;
  context.globalAlpha = 0.35;
  context.fillRect(30, 1, 3, 7);
  context.globalAlpha = 1;
  context.fillRect(30, 1, 3, 2);
  context.fillText(graph.value.gpuIdle ? "GPU idle" : "GPU", 36, 8);
  context.fillStyle = "rgba(255, 255, 255, 0.6)";
  context.textAlign = "right";
  context.fillText(`${GRAPH_WINDOW_MS / 1000} s · p95 at right`, width, 8);
  if (stalledMs.value !== null) {
    context.textAlign = "center";
    context.font = "11px ui-monospace, Menlo, monospace";
    context.fillStyle = "rgba(255, 255, 255, 0.75)";
    context.fillText(`no frames for ${formatInteger(stalledMs.value / 1000)} s`, width / 2, (height + GRAPH_TOP) / 2 + 4);
  }
  context.textAlign = "left";
}

let statsTimer: ReturnType<typeof setInterval> | undefined;
let graphTimer: ReturnType<typeof setInterval> | undefined;

watch(
  expanded,
  async (open) => {
    clearInterval(graphTimer);
    graphTimer = open ? setInterval(sample, GRAPH_REDRAW_MS) : undefined;
    if (open) {
      // The canvas mounts with the expanded view.
      await nextTick();
      sample();
    }
  },
  { immediate: true },
);

onMounted(() => {
  meter.acquire(USER);
  // Opened on a scene that draws nothing, no frame ever comes to time the stall from.
  const opened = performance.now();
  statsTimer = setInterval(() => {
    stats.value = meter.stats;
    const since = performance.now() - (meter.frames.at(-1)?.at ?? opened);
    stalledMs.value = since > STALL_MS ? since : null;
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
  gap: 4px;
  width: 208px;
  padding: 6px 9px 7px;
  border: none;
  border-radius: 10px;
  background: rgba(12, 14, 18, 0.86);
  color: #fff;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
  text-align: left;
  cursor: pointer;
}

.perf--expanded {
  width: 264px;
}

.perf__head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.perf__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.perf__fps {
  min-width: 3ch;
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
  text-align: right;
}

.perf__stack {
  display: flex;
  flex-direction: column;
  color: rgba(255, 255, 255, 0.65);
  font-size: 9.5px;
  line-height: 1.2;
  white-space: nowrap;
}

.perf__stack--end {
  align-items: flex-end;
  margin-left: auto;
}

/* Fixed columns: label, meter, value, unit. */
.perf__rows {
  display: grid;
  grid-template-columns: 30px 1fr 40px 26px;
  align-items: center;
  gap: 3px 4px;
}

.perf__label,
.perf__unit {
  color: rgba(255, 255, 255, 0.6);
  font-size: 10px;
}

.perf__value {
  font-weight: 600;
  text-align: right;
  white-space: nowrap;
}

.perf__value--small {
  font-weight: 400;
}

.perf__track {
  position: relative;
  height: 8px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
}

.perf__track--idle,
.perf__split--idle {
  background: repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.1) 0 3px, transparent 3px 6px);
}

.perf__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 2px;
}

/* The budget, at 1 / METER_SCALE. */
.perf__tick {
  position: absolute;
  top: -2px;
  bottom: -2px;
  left: calc(100% / 1.5);
  width: 1px;
  background: #fff;
}

.perf__graph {
  grid-column: 1 / -1;
  width: 100%;
  height: 84px;
  margin-top: 4px;
}

.perf__section {
  grid-column: 1 / -1;
  margin-top: 2px;
  color: rgba(255, 255, 255, 0.5);
  font-size: 9px;
}

.perf__split {
  display: flex;
  gap: 1px;
  height: 8px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
}

.perf__split > i {
  flex-basis: 0;
}

/* Up to half the budget, up to all of it, over: the first two in the side's colour at two strengths. */
.perf__split > i:first-child {
  opacity: 0.4;
}

.perf__split--idle > i {
  opacity: 0.35;
}

.perf__foot {
  display: flex;
  justify-content: space-between;
  margin-top: 1px;
  padding-top: 3px;
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.65);
  white-space: nowrap;
}

.perf__foot b {
  color: #fff;
}
</style>
