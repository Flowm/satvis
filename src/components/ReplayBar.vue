<!-- An overpass replay's controls, over the clock while one is on (ADR 0023). -->
<template>
  <div v-if="active" class="replay" role="group" aria-label="Overpass replay">
    <span class="replay__what" :title="title">{{ active.satellite }}</span>
    <span class="replay__where" :title="title">
      {{ active.station.name }}<template v-if="place.current"> · {{ overpassTime(place.current.entry) }}</template>
    </span>
    <div class="replay__controls">
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
          <UIcon :name="option.icon" />
        </button>
      </div>
      <button type="button" class="replay__button" :disabled="!place.previous" aria-label="Previous overpass" :title="stepTitle('previous')" @click="goToStep(place.previous)">
        <UIcon name="lucide:chevron-left" />
      </button>
      <button type="button" class="replay__button" :disabled="!place.next" aria-label="Next overpass" :title="stepTitle('next')" @click="goToStep(place.next)">
        <UIcon name="lucide:chevron-right" />
      </button>
      <button type="button" class="replay__button" aria-label="Exit replay" title="Take the granules off and go back to now" @click="exit">
        <UIcon name="lucide:x" />
      </button>
    </div>
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
import { REPLAY_CAMERAS } from "@/modules/ReplayCamera";

dayjs.extend(utc);

/** A replay over a station; a granule layer shown from its card or the Map panel has none. */
const { replay: active, camera, stepTo, watchFrom, stop } = useOverpassReplay();
const { now, goLive } = useViewerClock();
const { sats } = useController();

/** A replay step as replayPlace counts it: until its overpass ends. */
interface PlacedStep {
  entry: RecordedOverpass;
  end: number;
}

/** The replay's steps, by start, as replayPlace counts them. */
const placedSteps = computed((): PlacedStep[] => (active.value?.steps ?? []).map((entry) => ({ entry, end: entry.overpass.end })));

/** When the clock is set for a step: over its station, where the station is still there. */
function plan({ entry }: PlacedStep) {
  return stationReplay(entry.overpass, sats.stationPoint(entry.station) ?? active.value!.station.point, entry.satellite);
}

/** The replay's own step is of the layer and station on. */
const isOn = ({ entry }: PlacedStep) => entry.layer.token === active.value?.layer.token && entry.station === active.value?.station.name;

/** Where the clock is among the steps. */
const place = computed(() => replayPlace(placedSteps.value, now.value.getTime(), plan, isOn));

/** "11-20 11:42 UTC". */
const overpassTime = (entry: RecordedOverpass) => `${dayjs.utc(entry.overpass.start).format("MM-DD HH:mm")} UTC`;

/** The tooltip of the satellite and station: what is replayed, the instrument too. */
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
function goToStep(to: PlacedStep | undefined): void {
  if (to !== undefined) stepTo(to.entry);
}

/** Takes the replay's layer off and goes back to live, and the camera to where it was before. */
function exit(): void {
  stop({ returnView: true });
  goLive();
}
</script>

<style scoped>
.replay {
  display: grid;
  grid-template-areas:
    "what controls"
    "where where";
  grid-template-columns: minmax(0, 1fr) auto;
  width: fit-content;
  min-width: 260px;
  max-width: calc(100% - 16px);
  align-items: center;
  column-gap: 10px;
  margin: 0 auto 6px;
  padding: 3px 4px 5px 12px;
  border: 1px solid var(--panel-hairline);
  border-radius: 14px;
  background: var(--panel-surface);
  font-size: 12.5px;
  pointer-events: auto;
}

.replay__what {
  grid-area: what;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay__where {
  grid-area: where;
  overflow: hidden;
  padding-right: 8px;
  color: var(--panel-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay__controls {
  display: flex;
  grid-area: controls;
  align-items: center;
  gap: 2px;
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
</style>
