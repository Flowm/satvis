<!-- An overpass replay's controls, over the clock while one is on (ADR 0023): what is replayed, a step to the overpass before or after, and the way back to live. -->
<template>
  <div v-if="active" class="replay" role="group" aria-label="Overpass replay">
    <UIcon name="lucide:history" class="replay__icon" />
    <span class="replay__text" :title="title">
      <span class="replay__what">{{ active.satellite }} · {{ active.instrument }}</span>
      <span v-if="active.station" class="replay__where">over {{ active.station.name }}</span>
      <span v-if="place.current" class="replay__when">{{ overpassTime(place.current) }}</span>
    </span>
    <button type="button" class="replay__button" :disabled="!place.previous" aria-label="Previous overpass" :title="stepTitle('previous')" @click="step(place.previous)">
      <UIcon name="lucide:chevron-left" />
    </button>
    <button type="button" class="replay__button" :disabled="!place.next" aria-label="Next overpass" :title="stepTitle('next')" @click="step(place.next)">
      <UIcon name="lucide:chevron-right" />
    </button>
    <button type="button" class="replay__button replay__exit" aria-label="Exit replay" title="Take the granules off and go back to now" @click="exit">
      <UIcon name="lucide:x" />
      <span>Exit</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { computed, shallowRef, watch } from "vue";

import { useOverpassReplay } from "@/composables/useOverpassReplay";
import { useViewerClock } from "@/composables/useViewerClock";
import { orbitOverpasses, orbitReplay, type ReplayPlan, replayPlace, stationReplay } from "@/modules/overpassReplay";
import type { Overpass } from "@/modules/util/cmrGranules";

dayjs.extend(utc);

const { active, jump, stop } = useOverpassReplay();
const { now, goLive } = useViewerClock();

/** How often a satellite's own overpasses are listed afresh around the clock: a quarter of the day either side of it. */
const ORBITS_BUCKET_MS = 6 * 60 * 60 * 1000;

/** A satellite's overpasses around the clock, oldest first, for a replay not started from a station. */
const orbits = shallowRef<Overpass[]>([]);
watch(
  [() => (active.value?.station === undefined ? active.value?.layer.token : undefined), () => Math.floor(now.value.getTime() / ORBITS_BUCKET_MS)],
  ([token, bucket], _, onCleanup) => {
    orbits.value = [];
    const layer = active.value?.layer;
    if (token === undefined || layer === undefined) return;
    const asking = new AbortController();
    onCleanup(() => asking.abort());
    void orbitOverpasses(layer, (bucket + 0.5) * ORBITS_BUCKET_MS, asking.signal).then((overpasses) => {
      if (!asking.signal.aborted) orbits.value = overpasses ?? [];
    });
  },
  { immediate: true },
);

/** How each overpass is replayed: over the station, or from the middle of the orbit's day side. */
const plan = (overpass: Overpass): ReplayPlan => {
  const station = active.value?.station;
  return station ? stationReplay(overpass, station.point) : orbitReplay(overpass);
};

const place = computed(() => replayPlace(active.value?.station?.overpasses ?? orbits.value, now.value.getTime(), plan));

/** "11-20 11:42 UTC". */
const overpassTime = (overpass: Overpass) => `${dayjs.utc(overpass.start).format("MM-DD HH:mm")} UTC`;

const title = computed(() => {
  const replay = active.value;
  return replay && `Replaying the granules ${replay.satellite}'s ${replay.instrument} sensed${replay.station ? ` over ${replay.station.name}` : ""}`;
});

function stepTitle(which: "previous" | "next"): string {
  const overpass = place.value[which];
  return overpass ? `${which === "next" ? "Next" : "Previous"} overpass, ${overpassTime(overpass)}` : `No ${which} overpass listed`;
}

function step(overpass: Overpass | undefined): void {
  if (overpass !== undefined) jump(plan(overpass));
}

function exit(): void {
  stop();
  goLive();
}
</script>

<style scoped>
.replay {
  display: flex;
  width: fit-content;
  max-width: calc(100% - 16px);
  align-items: center;
  gap: 4px;
  margin: 0 auto 6px;
  padding: 3px 4px 3px 10px;
  border: 1px solid var(--panel-hairline);
  border-radius: 999px;
  background: var(--panel-surface);
  font-size: 12.5px;
  pointer-events: auto;
}

.replay__icon {
  flex: none;
  color: var(--panel-accent);
}

.replay__text {
  display: flex;
  min-width: 0;
  gap: 6px;
  overflow: hidden;
  padding-right: 4px;
  white-space: nowrap;
}

.replay__what {
  font-weight: 600;
}

.replay__where,
.replay__when {
  overflow: hidden;
  color: var(--panel-muted);
  text-overflow: ellipsis;
}

.replay__button {
  display: inline-flex;
  flex: none;
  min-width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 999px;
  color: var(--panel-ink);
  cursor: pointer;
}

.replay__button:hover:not(:disabled) {
  background: #edffff1f;
}

.replay__button:disabled {
  color: var(--panel-faint);
  cursor: default;
}

.replay__exit {
  padding-right: 10px;
  font-weight: 600;
}
</style>
