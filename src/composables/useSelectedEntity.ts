// useSelectedEntity — bridges the Cesium selection to Vue reactivity for the
// entity info panel. `viewer.selectedEntity` stays the single source of truth:
// this composable only observes it (via selectedEntityChanged) and resolves it
// to the owning SatelliteComponentCollection or GroundStationEntity; it never
// changes the selection itself except in `deselect()`, which mirrors the native
// InfoBox close button (`viewer.selectedEntity = undefined`).
//
// State lives at module scope as a lazy singleton, wired up on first use against
// the controller its first caller hands it.
// While something is selected, a 1 s periodic clock callback refreshes the
// time-dependent data (position, pass countdowns) and re-resolves the selection
// so a satellite disposed mid-selection (e.g. its tag toggled off) hides the
// panel within a second. The callback is gated on *simulation* time, so the
// countdown freezes while the clock is paused — the same behavior the old
// InfoBox had with its 1 s-cached description CallbackProperty.
//
// Cesium objects are held via shallowRef/markRaw only: a deep reactive proxy
// would break the `viewer.selectedEntity === entity` identity checks inside
// `isSelected`.

import { JulianDate } from "@cesium/engine";
import { storeToRefs } from "pinia";
import { computed, markRaw, ref, shallowRef, watch, type Ref, type ShallowRef } from "vue";

import { SKY_MODE } from "../config/viewModes";
import type { CesiumController } from "../modules/CesiumController";
import type { GroundStationEntity } from "../modules/GroundStationEntity";
import { filterPasses, toPassRows, type Pass, type PassRow } from "../modules/PassPredictor";
import type { SatelliteComponentCollection } from "../modules/SatelliteComponentCollection";
import { CesiumCallbackHelper } from "../modules/util/CesiumCallbackHelper";
import { getElementsInfo, getSatelliteInfo, type ElementsInfo } from "../modules/util/entityInfo";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";

export type Selection = { kind: "satellite"; sat: SatelliteComponentCollection } | { kind: "groundstation"; gs: GroundStationEntity };

export interface PositionRow {
  label: string;
  value: string;
}

const selection: ShallowRef<Selection | null> = shallowRef(null);
const isTracked = ref(false);
const name = ref("");
const position: Ref<PositionRow[]> = ref([]);
const passRows: Ref<PassRow[]> = ref([]);
// The same passes `passRows` was formatted from, in the same order, for the parts
// of the panel that draw rather than tabulate. The timeline and the next-pass
// headline need the numbers, not the strings.
const passes: ShallowRef<readonly Pass[]> = shallowRef([]);
// The ongoing or next pass, which is the panel's headline. Held rather than derived
// in the component so "next" is decided once, against the same instant the rows
// were formatted at.
const nextPass: ShallowRef<Pass | null> = shallowRef(null);
// How many distinct subjects the pass list spans. One makes the first column thirty
// repetitions of the same word, so the panel drops it.
const subjectCount = ref(0);
// Simulation time in epoch milliseconds, as of the last refresh: what the countdowns
// and the timeline are drawn against. The clock itself is not reactive.
const nowMs = ref(0);
/**
 * The tab the user last chose, kept across selections rather than reset with them.
 *
 * Not the *active* tab: a ground station has no Details, so opening one falls back
 * to Passes without forgetting that Details is where you were. Selecting a
 * satellite again puts you back there. Module scope, like the rest of this file's
 * state, so it survives the panel unmounting with the selection.
 */
const preferredTab = ref("details");
// The pass picked off the timeline, by start time. Null is "none picked".
const pickedPassMs = ref<number | null>(null);
// Whether the pass list is still being computed, so the panel can say "not yet"
// instead of "none". See `PassPredictor.settled` for why the two look alike.
const passesPending = ref(false);
// Whether the entity has any computed passes at all (before dropping past
// ones); distinguishes the empty-state texts from an empty passes table.
const hasAnyPasses = ref(false);
// Include already-finished passes in the table. Off by default so the list
// starts at the ongoing/next pass.
const showPastPasses = ref(false);
const groundStationAvailable = ref(false);
const elements: ShallowRef<ElementsInfo | null> = shallowRef(null);
// Static facts about the satellite (derived orbit class + whatever its record
// carries). Resolved once per selection, not per tick — none of it is time-dependent.
const satelliteInfo: ShallowRef<[string, string][]> = shallowRef([]);

// Given on first use rather than found on `globalThis`, so the dependency is in
// the signature and app.ts decides which instance this singleton speaks for.
let controller: CesiumController | undefined;
let removeTickCallback: (() => void) | undefined;

function cc(): CesiumController {
  if (!controller) {
    throw new Error("useSelectedEntity used before it was given a CesiumController");
  }
  return controller;
}

/**
 * Offered on a ground station, and only from the globe. A satellite has no answer
 * to "the sky from where". Inside the sky view the control would be asking for the
 * view it is already in.
 */
const canEnterSkyView = computed(() => selection.value?.kind === "groundstation" && useCesiumStore().sceneMode !== SKY_MODE);

function selectionTarget(sel: Selection | null): SatelliteComponentCollection | GroundStationEntity | null {
  if (!sel) {
    return null;
  }
  return sel.kind === "satellite" ? sel.sat : sel.gs;
}

function resolveSelection(): Selection | null {
  const { viewer, sats } = cc();
  if (!viewer.selectedEntity) {
    return null;
  }
  const sat = sats.activeSatellites.find((s) => s.isSelected);
  if (sat) {
    return { kind: "satellite", sat: markRaw(sat) };
  }
  const gs = sats.groundStations.find((g) => g.isSelected);
  if (gs) {
    return { kind: "groundstation", gs: markRaw(gs) };
  }
  return null;
}

function syncTracked(): void {
  isTracked.value = selectionTarget(selection.value)?.isTracked ?? false;
}

function refreshData(sel: Selection, time: JulianDate): void {
  const { sats } = cc();
  const mode = sats.overpassMode;
  groundStationAvailable.value = sats.groundStationAvailable;

  if (sel.kind === "satellite") {
    const { props } = sel.sat;
    name.value = props.name;
    // Window-guarded: recomputes only when outside the current pass window,
    // which keeps the list valid after large time jumps.
    const allPasses = props.passPredictor.passes(time);
    const cartographic = props.orbit.positionGeodetic(JulianDate.toDate(time), true);
    position.value = cartographic
      ? [
          { label: "Name", value: props.name },
          { label: "Latitude", value: `${cartographic.latitude.toFixed(2)}°` },
          { label: "Longitude", value: `${cartographic.longitude.toFixed(2)}°` },
          { label: "Altitude", value: `${(cartographic.height / 1000).toFixed(2)} km` },
          { label: "Velocity", value: `${(cartographic.velocity ?? 0).toFixed(2)} km/s` },
        ]
      : [];
    passesPending.value = !props.passPredictor.settled(time);
    hasAnyPasses.value = allPasses.length > 0;
    setPasses(filterPasses(allPasses, time, showPastPasses.value), time, "groundStationName", mode);
  } else {
    const { gs } = sel;
    name.value = gs.name;
    position.value = [
      { label: "Name", value: gs.name },
      { label: "Latitude", value: `${gs.position.latitude.toFixed(2)}°` },
      { label: "Longitude", value: `${gs.position.longitude.toFixed(2)}°` },
    ];
    const allPasses = gs.passes(time);
    passesPending.value = !gs.passesSettled(time);
    hasAnyPasses.value = allPasses.length > 0;
    setPasses(filterPasses(allPasses, time, showPastPasses.value), time, "name", mode);
  }
}

/**
 * Publish one pass list four ways: formatted rows, the raw passes behind them, the
 * one that is next, and how many subjects they span.
 *
 * Together in one function because they must agree. Format the table at one instant
 * and choose the headline at another, and "next pass" ends up naming a row that is
 * not the highlighted one.
 */
function setPasses(visible: Pass[], time: JulianDate, nameField: "name" | "groundStationName", mode: string): void {
  const at = JulianDate.toDate(time).getTime();
  nowMs.value = at;
  passes.value = visible;
  passRows.value = toPassRows(visible, time, nameField, mode);
  nextPass.value = visible.find((pass) => pass.end >= at) ?? null;
  subjectCount.value = new Set(visible.map((pass) => pass[nameField] ?? "")).size;
}

function update(time?: JulianDate): void {
  const { viewer } = cc();
  const now = time ?? viewer.clock.currentTime;
  const next = resolveSelection();
  const previousTarget = selectionTarget(selection.value);

  if (selectionTarget(next) !== previousTarget) {
    selection.value = next;
    elements.value = next?.kind === "satellite" ? getElementsInfo(next.sat.props.orbit) : null;
    satelliteInfo.value = next?.kind === "satellite" ? getSatelliteInfo(next.sat.props.orbit, next.sat.props.orbitClass, next.sat.props.metadata) : [];
    // A pass picked on one entity's timeline means nothing on the next one's.
    pickedPassMs.value = null;
    if (next && !removeTickCallback) {
      removeTickCallback = CesiumCallbackHelper.createPeriodicTimeCallback(viewer, 1, (tickTime) => update(tickTime));
    } else if (!next && removeTickCallback) {
      removeTickCallback();
      removeTickCallback = undefined;
    }
  }

  if (next) {
    refreshData(next, now);
  }
  syncTracked();
}

function init(): void {
  const { viewer } = cc();
  viewer.selectedEntityChanged.addEventListener(() => update());
  viewer.trackedEntityChanged.addEventListener(() => syncTracked());
  // Flip the passes table columns immediately on mode change instead of
  // waiting for the next periodic refresh. The manager (cc.sats.overpassMode)
  // is updated by the Satvis.vue store watcher, which runs before this one
  // (registered earlier), so reading the manager value in refreshData is safe.
  const { overpassMode } = storeToRefs(useSatStore());
  watch(overpassMode, () => update());
  // Rebuild the table immediately when past passes are toggled instead of
  // waiting for the next periodic refresh.
  watch(showPastPasses, () => update());
  // Pick up a selection made before the first panel mount.
  update();
}

export function useSelectedEntity(instance: CesiumController) {
  if (!controller) {
    controller = instance;
    init();
  }

  function deselect(): void {
    cc().viewer.selectedEntity = undefined;
  }

  /**
   * Pick a pass, or unpick it. Held by start time rather than by list index. The
   * list is rebuilt every second, and shifts by one whenever a pass ends or past
   * passes are toggled. An index would quietly come to mean a different row.
   */
  function pickPass(startMs: number): void {
    pickedPassMs.value = pickedPassMs.value === startMs ? null : startMs;
  }

  /**
   * Stand at the selected ground station and look up.
   *
   * Designating rather than reordering. `sat.observerStation` names which station
   * the sky view stands at, so nothing about the list moves: it keeps its order,
   * `?gs=` keeps its order, and the station entities are not rebuilt. The panel
   * stays open on the place you are now standing.
   */
  function enterSkyView(): void {
    const sel = selection.value;
    if (sel?.kind !== "groundstation") {
      return;
    }
    // `sats.groundStations` is built by mapping the store array, so indices agree.
    useSatStore().setObserverStation(cc().sats.groundStations.indexOf(sel.gs));
    useCesiumStore().sceneMode = SKY_MODE;
  }

  function toggleTrack(): void {
    const target = selectionTarget(selection.value);
    if (!target) {
      return;
    }
    if (target.isTracked) {
      cc().viewer.trackedEntity = undefined;
    } else {
      // Animated, but not while the sky view holds the camera: a flight would fight it.
      target.track(!cc().skyView.active);
    }
  }

  return {
    selection,
    isTracked,
    name,
    position,
    passRows,
    passes,
    nextPass,
    subjectCount,
    nowMs,
    hasAnyPasses,
    passesPending,
    showPastPasses,
    pickedPassMs,
    pickPass,
    preferredTab,
    groundStationAvailable,
    elements,
    satelliteInfo,
    canEnterSkyView,
    enterSkyView,
    deselect,
    toggleTrack,
  };
}
