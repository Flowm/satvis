<template>
  <div class="gsList">
    <div v-if="stations.length === 0" class="toolbarNote gsList__empty">None yet — pick one on the globe, or use your own position.</div>
    <div
      v-for="(station, index) in stations"
      :key="index"
      class="gsList__row"
      :class="{ 'gsList__row--observer': observing(index), 'gsList__row--dragged': drag?.from === index, 'gsList__row--settling': settling }"
      :style="{ transform: `translateY(${offsetOf(index)}px)` }"
    >
      <!-- Where the sky view stands, while it is up: Look up and a location's panel choose it. -->
      <span class="gsList__rank" :class="{ 'gsList__rank--observer': observing(index) }" :title="observing(index) ? 'The sky view stands here' : undefined">
        {{ observing(index) ? "◉" : index + 1 }}
      </span>
      <!-- Keyboard-operable as well as draggable: dragging is the only other way to reorder. -->
      <span
        class="gsList__grip"
        role="button"
        tabindex="0"
        title="Drag to reorder"
        @pointerdown="startDrag(index, $event)"
        @pointermove="moveDrag($event)"
        @pointerup="endDrag($event)"
        @pointercancel="endDrag($event)"
        @keydown.up.prevent="nudge(index, -1)"
        @keydown.down.prevent="nudge(index, 1)"
      >
        <UIcon name="lucide:grip-vertical" />
      </span>
      <input
        class="gsList__name"
        type="text"
        :value="station.name ?? ''"
        placeholder="unnamed"
        aria-label="Name"
        @change="commitName(index, $event)"
        @keydown.enter="commit"
        @keydown.esc="abandon($event, station.name ?? '')"
      />
      <input
        class="gsList__coord"
        type="text"
        inputmode="decimal"
        :value="station.lat"
        aria-label="Latitude"
        @change="commitCoordinate(index, 'lat', $event)"
        @keydown.enter="commit"
        @keydown.esc="abandon($event, String(station.lat))"
      />
      <input
        class="gsList__coord"
        type="text"
        inputmode="decimal"
        :value="station.lon"
        aria-label="Longitude"
        @change="commitCoordinate(index, 'lon', $event)"
        @keydown.enter="commit"
        @keydown.esc="abandon($event, String(station.lon))"
      />
      <button type="button" class="gsList__remove" title="Remove" @click="removeAt(index)">×</button>
    </div>

    <div class="toolbarActions">
      <button type="button" :class="{ 'gsList__action--on': pickMode }" :aria-pressed="pickMode" @click="pickMode = !pickMode">
        <UIcon name="lucide:crosshair" />
        {{ pickMode ? "Cancel pick" : "Pick on globe" }}
      </button>
      <button type="button" :disabled="locating" @click="void locate()">
        <span v-if="locating" class="toolbarSpinner"></span>
        My location
      </button>
    </div>

    <div v-if="pickMode" class="toolbarNote gsList__pickNote">Choose a spot on the globe for the station.</div>
    <div v-if="sceneMode === SKY_MODE" class="toolbarNote">The sky view stands at ◉.</div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { nextTick, ref, watch } from "vue";

import { useController } from "../composables/useController";
import { useGeolocation } from "../composables/useGeolocation";
import { SKY_MODE } from "../config/viewModes";
import { dragShift, dropIndex, MAX_LATITUDE, MAX_LONGITUDE, parseCoordinate } from "../modules/util/groundStationEdits";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";

const cc = useController();
const satStore = useSatStore();
const { groundStations: stations, observerStation } = storeToRefs(satStore);
const { pickMode, sceneMode } = storeToRefs(useCesiumStore());

/** Whether the sky view is up and stands on station `index`. */
const observing = (index: number): boolean => sceneMode.value === SKY_MODE && index === observerStation.value;
// The canvas, not a class on the page: Cesium's own widgets keep their cursors.
watch(pickMode, (on) => {
  cc.viewer.scene.canvas.style.cursor = on ? "crosshair" : "";
});
const { pending: locating, locate } = useGeolocation(cc);

/**
 * Puts back what the store kept (rounded, or the old value if refused). Vue does not:
 * the bound value has not changed, so it has nothing to patch.
 */
function settle(input: HTMLInputElement, value: string): void {
  input.value = value;
}

/**
 * Enter and Escape both blur, because blur raises the `change` that commits: a text
 * input outside a form does not raise `change` on Enter (measured). Escape restores
 * the stored value first, so its blur commits nothing.
 */
function commit(event: KeyboardEvent): void {
  (event.target as HTMLInputElement).blur();
}

function abandon(event: KeyboardEvent, stored: string): void {
  const input = event.target as HTMLInputElement;
  input.value = stored;
  input.blur();
}

/**
 * On `change`, not `input`: each commit writes the store and the url, and recomputes every satellite's passes.
 */
function commitName(index: number, event: Event): void {
  const input = event.target as HTMLInputElement;
  satStore.renameGroundStation(index, input.value);
  settle(input, stations.value[index]?.name ?? "");
}

function commitCoordinate(index: number, field: "lat" | "lon", event: Event): void {
  const input = event.target as HTMLInputElement;
  const value = parseCoordinate(input.value, field === "lat" ? MAX_LATITUDE : MAX_LONGITUDE);
  if (value !== undefined) {
    satStore.relocateGroundStation(index, field, value);
  }
  settle(input, String(stations.value[index]?.[field] ?? ""));
}

function removeAt(index: number): void {
  satStore.removeGroundStation(index);
}

/**
 * Pointer events, not HTML5 drag-and-drop, which does not work on touch. The row
 * height is measured per drag, so the arithmetic cannot drift from the stylesheet.
 */
const drag = ref<{ from: number; to: number; offset: number; rowHeight: number } | undefined>();

/**
 * Transitions off for the frame a drop lands in. Rows are keyed by position, so a
 * reorder swaps their content while they hold the drag transform; with the transition
 * on, the row visibly flies back. Cleared a frame later.
 */
const settling = ref(false);

function startDrag(index: number, event: PointerEvent): void {
  const handle = event.currentTarget as HTMLElement;
  const row = handle.parentElement?.getBoundingClientRect();
  handle.setPointerCapture(event.pointerId);
  drag.value = { from: index, to: index, offset: 0, rowHeight: row?.height ?? 0 };
}

function moveDrag(event: PointerEvent): void {
  const current = drag.value;
  if (!current) {
    return;
  }
  // The handle has pointer capture, so every move arrives here.
  const offset = current.offset + event.movementY;
  drag.value = { ...current, offset, to: dropIndex(current.from, offset, current.rowHeight, stations.value.length) };
}

function endDrag(event: PointerEvent): void {
  const current = drag.value;
  drag.value = undefined;
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  // Skip the store write for a tap.
  if (current && current.to !== current.from) {
    settling.value = true;
    reorder(current.from, current.to - current.from);
    void nextTick(() => requestAnimationFrame(() => (settling.value = false)));
  }
}

function reorder(index: number, by: number): void {
  satStore.moveGroundStation(index, by);
}

function nudge(index: number, by: number): void {
  reorder(index, by);
}

function offsetOf(index: number): number {
  const current = drag.value;
  if (!current) {
    return 0;
  }
  return index === current.from ? current.offset : dragShift(index, current.from, current.to, current.rowHeight);
}
</script>

<style scoped>
.gsList__empty {
  font-style: italic;
}

.gsList__row {
  align-items: center;
  background-color: #464b50;
  border-radius: 6px;
  display: flex;
  gap: 3px;
  height: 24px;
  margin: 1px 0;
  opacity: 0.85;
  padding: 0 3px;
  transition: transform 120ms ease-out;
}

.gsList__row--observer {
  background-color: #4a5b50;
  opacity: 1;
}

/* See `settling`. */
.gsList__row--settling {
  transition: none;
}

.gsList__row--dragged {
  box-shadow: 0 2px 8px #0006;
  position: relative;
  transition: none;
  z-index: 1;
}

.gsList__rank {
  color: #4ade8099;
  flex: none;
  font-size: 11px;
  line-height: 24px;
  text-align: center;
  user-select: none;
  width: 12px;
}

.gsList__rank--observer {
  color: #4ade80;
}

.gsList__grip {
  align-items: center;
  cursor: grab;
  display: flex;
  flex: none;
  font-size: 12px;
  opacity: 0.45;
  /* A touch drag moves the row instead of scrolling the panel. */
  touch-action: none;
  user-select: none;
}

.gsList__grip:hover {
  opacity: 0.9;
}

.gsList__grip:active {
  cursor: grabbing;
  opacity: 1;
}

.gsList__grip:focus-visible {
  border-radius: 3px;
  outline: 1px solid #4ade80;
}

.gsList__name,
.gsList__coord {
  background: none;
  border: none;
  border-bottom: 1px solid #edffff26;
  color: #edffff;
  min-width: 0;
  padding: 0 1px;
}

.gsList__name:focus,
.gsList__coord:focus {
  border-bottom-color: #4ade80;
  outline: none;
}

/* An explicit width: an input's intrinsic width is about 20 characters, and the panel is shrink-to-fit. */
.gsList__name {
  flex: 1 1 auto;
  font-size: 12px;
  width: 74px;
}

.gsList__name::placeholder {
  color: #edffff;
  font-style: italic;
  opacity: 0.35;
}

.gsList__coord {
  flex: 0 0 auto;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  width: 52px;
}

.gsList__remove {
  background: none;
  border: none;
  color: #edffff;
  cursor: pointer;
  flex: none;
  font-size: 15px;
  line-height: 1;
  opacity: 0.6;
  padding: 0 1px;
}

.gsList__remove:hover {
  color: #fca5a5;
  opacity: 1;
}

/* Pick mode stays on until a click on the globe. */
.toolbarActions .gsList__action--on,
.toolbarActions .gsList__action--on:hover:not(:disabled) {
  background-color: #4ade80;
  color: #14281b;
  font-weight: 600;
}

.gsList__pickNote {
  color: #4ade80;
  opacity: 1;
}
</style>
