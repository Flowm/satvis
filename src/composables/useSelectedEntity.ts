// The Cesium selection, as Vue state for the entity info panel. `viewer.selectedEntity`
// stays the source of truth; only `deselect()` writes it. A module-scope singleton.
//
// While something is selected, a callback refreshes every second of both simulation and
// real time, so countdowns freeze while paused and a satellite disposed mid-selection
// hides the panel. Cesium objects stay shallowRef/markRaw: a deep proxy breaks the
// `viewer.selectedEntity === entity` check in `isSelected`.

import { JulianDate } from "@cesium/engine";
import { storeToRefs } from "pinia";
import { computed, markRaw, ref, shallowRef, watch, type Ref, type ShallowRef } from "vue";

import { SKY_MODE } from "../config/viewModes";
import type { CesiumController } from "../modules/CesiumController";
import type { GroundStationEntity } from "../modules/GroundStationEntity";
import { filterPasses, toPassRows, type Pass, type PassRow } from "../modules/PassPredictor";
import type { SatelliteComponentCollection } from "../modules/SatelliteComponentCollection";
import { CesiumCallbackHelper } from "../modules/util/CesiumCallbackHelper";
import { getElementsInfo, getSatelliteInfo, staleElementsNotice, type ElementsInfo } from "../modules/util/entityInfo";
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
/** The passes behind `passRows`, in the same order. */
const passes: ShallowRef<readonly Pass[]> = shallowRef([]);
/** The ongoing or next pass. */
const nextPass: ShallowRef<Pass | null> = shallowRef(null);
/** Distinct subjects in the pass list. At one, the panel drops the first column. */
const subjectCount = ref(0);
/** Simulation time in epoch milliseconds at the last refresh. The clock itself is not reactive. */
const nowMs = ref(0);
/**
 * The tab the user last chose, not the active one: a ground station has no Details, but
 * selecting a satellite returns there.
 */
const preferredTab = ref("details");
/** The pass picked off the timeline, by start time. */
const pickedPassMs = ref<number | null>(null);
/** Lets the panel say "not yet" instead of "none" (see `PassPredictor.settled`). */
const passesPending = ref(false);
/** Whether any passes exist before past ones are dropped; picks the empty-state text. */
const hasAnyPasses = ref(false);
const showPastPasses = ref(false);
const groundStationAvailable = ref(false);
const elements: ShallowRef<ElementsInfo | null> = shallowRef(null);
/** Set while the simulation time is far enough from the element epoch that the position may be inaccurate. */
const staleNotice = ref<string | undefined>(undefined);
/** Resolved once per selection: none of it is time-dependent. */
const satelliteInfo: ShallowRef<[string, string][]> = shallowRef([]);

let controller: CesiumController | undefined;
let removeTickCallback: (() => void) | undefined;

function cc(): CesiumController {
  if (!controller) {
    throw new Error("useSelectedEntity used before it was given a CesiumController");
  }
  return controller;
}

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
    // Recomputes only outside the current pass window, so large time jumps stay valid.
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
    staleNotice.value = elements.value ? staleElementsNotice(elements.value.epochMs, JulianDate.toDate(time).getTime()) : undefined;
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
    staleNotice.value = undefined;
    const allPasses = gs.passes(time);
    passesPending.value = !gs.passesSettled(time);
    hasAnyPasses.value = allPasses.length > 0;
    setPasses(filterPasses(allPasses, time, showPastPasses.value), time, "name", mode);
  }
}

/** All four must come from one instant, or "next pass" names a row that is not highlighted. */
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
      removeTickCallback = CesiumCallbackHelper.createThrottledTimeCallback(viewer, 1, (tickTime) => update(tickTime));
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
  // sceneSync's watcher (started in app.ts) sets cc.sats.overpassMode first, so update() reads the new mode.
  const { overpassMode } = storeToRefs(useSatStore());
  watch(overpassMode, () => update());
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

  /** By start time, not index: the list shifts whenever a pass ends or past passes are toggled. */
  function pickPass(startMs: number): void {
    pickedPassMs.value = pickedPassMs.value === startMs ? null : startMs;
  }

  /** Designates the observer station without reordering the list, `?gs=` or the station entities. */
  function enterSkyView(): void {
    const sel = selection.value;
    if (sel?.kind !== "groundstation") {
      return;
    }
    useSatStore().setObserverStation(sel.gs.index);
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
    staleNotice,
    satelliteInfo,
    canEnterSkyView,
    enterSkyView,
    deselect,
    toggleTrack,
  };
}
