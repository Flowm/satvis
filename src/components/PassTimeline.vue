<!-- Satellite selections only: a ground station has about 500 passes (Munich test case),
     too many to hit one bar. The arithmetic lives in modules/util/passTimeline.ts. -->
<template>
  <div class="timeline">
    <div class="timeline__track">
      <span v-for="tick in layout.ticks" :key="tick.label" class="timeline__tick" :style="{ left: `${tick.pct}%` }">
        <i />
        <em>{{ tick.label }}</em>
      </span>
      <button
        v-for="block in layout.blocks"
        :key="block.key"
        type="button"
        class="timeline__pass"
        :class="[`timeline__pass--${block.band}`, { 'is-live': block.live, 'is-past': block.past, 'is-picked': block.startMs === picked }]"
        :style="{ left: `${block.leftPct}%`, width: `${block.widthPct}%`, height: `${block.heightPct}%` }"
        :title="titleOf(block.startMs)"
        :aria-label="titleOf(block.startMs)"
        @click="emit('pick', block.startMs)"
      />
      <span class="timeline__now" :style="{ left: `${layout.nowPct}%` }" />
    </div>
    <div class="timeline__legend">
      <span v-for="band in BANDS" :key="band.band"><i :class="`timeline__pass--${band.band}`" />{{ band.label }}</span>
      <span v-if="layout.beyond > 0" class="timeline__more">+{{ layout.beyond }} past {{ layout.horizonLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { formatCountdown, passSummary, type Pass } from "../modules/PassPredictor";
import { passTimelineLayout } from "../modules/util/passTimeline";

const props = defineProps<{
  /** The same passes the table shows, in the same order. */
  passes: readonly Pass[];
  nowMs: number;
  /** `elevation` or `swath`; only the legend's wording depends on it. */
  mode: string;
  /** Start time of the picked pass, in ms. */
  picked: number | null;
}>();

const emit = defineEmits<{ pick: [startMs: number] }>();

const layout = computed(() => passTimelineLayout(props.passes, props.nowMs));

const BANDS = computed(() =>
  props.mode === "swath"
    ? ([
        { band: "high", label: "near centre" },
        { band: "mid", label: "mid" },
        { band: "low", label: "edge" },
      ] as const)
    : ([
        { band: "high", label: "≥45°" },
        { band: "mid", label: "20–45°" },
        { band: "low", label: "<20°" },
      ] as const),
);

const byStart = computed(() => new Map(props.passes.map((pass) => [pass.start, pass])));

function titleOf(startMs: number): string {
  const pass = byStart.value.get(startMs);
  if (!pass) {
    return "";
  }
  const subject = pass.groundStationName ?? pass.name;
  return `${subject ? `${subject} · ` : ""}in ${formatCountdown(props.nowMs, pass)} · ${passSummary(pass)}`;
}
</script>

<style scoped>
.timeline {
  padding-bottom: 4px;
}

.timeline__track {
  position: relative;
  height: 42px;
  border-bottom: 1px solid #ffffff30;
  background: #ffffff08;
}

.timeline__tick {
  position: absolute;
  top: 0;
  bottom: 0;
}

.timeline__tick i {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: #ffffff14;
}

.timeline__tick em {
  position: absolute;
  bottom: -13px;
  left: 2px;
  color: #edffff70;
  font-size: 9px;
  font-style: normal;
}

.timeline__pass {
  position: absolute;
  bottom: 0;
  min-width: 3px;
  border-radius: 1px 1px 0 0;
  cursor: pointer;
}

/* Okabe-Ito blue for the best passes, neutrals below, as in ORBIT_CLASS_COLOR. */
.timeline__pass--high {
  background: #56b4e9;
}

.timeline__pass--mid {
  background: #b8c4c4;
}

.timeline__pass--low {
  background: #8a9494;
}

.timeline__pass:hover {
  outline: 1px solid #ffffffcc;
}

.timeline__pass.is-live {
  box-shadow:
    0 0 0 1px #ffffff,
    0 0 8px #56b4e9;
}

.timeline__pass.is-past {
  opacity: 0.35;
}

/* Not the next-pass green: a pass can be both picked and next. */
.timeline__pass.is-picked {
  opacity: 1;
  outline: 2px solid #edffff;
  outline-offset: 1px;
}

.timeline__now {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  background: #4caf50;
}

.timeline__legend {
  display: flex;
  gap: 10px;
  margin-top: 15px;
  color: #edffff80;
  font-size: 9.5px;
}

.timeline__legend i {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 3px;
  border-radius: 1px;
}

.timeline__more {
  margin-left: auto;
}
</style>
