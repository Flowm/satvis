<!-- An overpass replay's controls, over the clock while one is on (ADR 0023). -->
<template>
  <div v-if="active" class="replay" role="group" aria-label="Overpass replay">
    <UIcon name="lucide:history" class="replay__icon" />
    <span class="replay__text" :title="title">
      <span class="replay__what">{{ active.satellite }} · {{ active.instrument }}</span>
      <span class="replay__where">over {{ active.station.name }}</span>
      <span v-if="place.current" class="replay__when">{{ overpassTime(place.current.entry) }}</span>
    </span>
    <div class="replay__cameras" role="radiogroup" aria-label="Replay camera">
      <button
        v-for="option in REPLAY_CAMERAS"
        :key="option.value"
        type="button"
        role="radio"
        class="replay__button"
        :class="{ 'replay__button--on': camera === option.value }"
        :aria-checked="camera === option.value"
        :aria-label="`${option.label} camera`"
        :title="option.title"
        @click="watchFrom(option.value)"
      >
        <UIcon :name="CAMERA_ICONS[option.value]" />
      </button>
    </div>
    <button type="button" class="replay__button" :disabled="!place.previous" aria-label="Previous overpass" :title="stepTitle('previous')" @click="go(place.previous)">
      <UIcon name="lucide:chevron-left" />
    </button>
    <button type="button" class="replay__button" :disabled="!place.next" aria-label="Next overpass" :title="stepTitle('next')" @click="go(place.next)">
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
import { computed } from "vue";

import { useController } from "@/composables/useController";
import { useOverpassReplay } from "@/composables/useOverpassReplay";
import { useViewerClock } from "@/composables/useViewerClock";
import { replayPlace, stationReplay } from "@/modules/overpassReplay";
import type { RecordedOverpass } from "@/modules/passImagery";
import { REPLAY_CAMERAS, type ReplayCamera } from "@/modules/ReplayCamera";

dayjs.extend(utc);

/** Each replay camera's button. */
const CAMERA_ICONS: Record<ReplayCamera, string> = { broadcast: "lucide:video", nadir: "lucide:locate-fixed", chase: "lucide:satellite" };

/** A replay over a station; a granule layer shown from its card or the Map panel has none. */
const { replay: active, camera, step, watchFrom, stop } = useOverpassReplay();
const { now, goLive } = useViewerClock();
const { sats } = useController();

/** A step as replayPlace counts it: until its overpass ends. */
interface Step {
  entry: RecordedOverpass;
  end: number;
}

const steps = computed((): Step[] => (active.value?.steps ?? []).map((entry) => ({ entry, end: entry.overpass.end })));

/** When the clock is set for a step: its station's, where the station is still there. */
function plan({ entry }: Step) {
  const station = sats.groundStations.find((gs) => gs.name === entry.station)?.position ?? active.value!.station.point;
  return stationReplay(entry.overpass, station, entry.satellite);
}

/** The replay's own step is of the layer and station on. */
const isOn = ({ entry }: Step) => entry.layer.token === active.value?.layer.token && entry.station === active.value?.station.name;

const place = computed(() => replayPlace(steps.value, now.value.getTime(), plan, isOn));

/** "11-20 11:42 UTC". */
const overpassTime = (entry: RecordedOverpass) => `${dayjs.utc(entry.overpass.start).format("MM-DD HH:mm")} UTC`;

const title = computed(() => {
  const on = active.value;
  return on && `Replaying the granules ${on.satellite}'s ${on.instrument} sensed over ${on.station.name}`;
});

/** The step's tooltip: the overpass it goes to, or that there is none. */
function stepTitle(which: "previous" | "next"): string {
  const to = place.value[which]?.entry;
  return to ? `${which === "next" ? "Next" : "Previous"} overpass: ${to.satellite} over ${to.station}, ${overpassTime(to)}` : `No ${which} overpass listed`;
}

/** Replays the step, at the speed the clock runs. */
function go(to: Step | undefined): void {
  if (to !== undefined) step(to.entry);
}

/** Takes the replay's layer off and goes back to live; the camera stays. */
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

.replay__button--on {
  background: #edffff2e;
  color: var(--panel-accent);
}

.replay__cameras {
  display: flex;
  flex: none;
  gap: 1px;
  padding: 0 4px;
  border-right: 1px solid var(--panel-hairline);
  border-left: 1px solid var(--panel-hairline);
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
