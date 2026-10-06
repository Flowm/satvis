// The one place store state becomes globe state. Only the tracked satellite and the
// sky view's observer travel back, as callbacks.

import { JulianDate } from "@cesium/engine";
import { nextTick, watch } from "vue";

import { currentPosition } from "../composables/useGeolocation";
import { useToastProxy } from "../composables/useToastProxy";
import { BUILTIN_STAR_MAP, starMapRecovery } from "../config/starMaps";
import { SKY_MODE } from "../config/viewModes";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import { activeTargetEntries } from "./satelliteActivation";
import type { CatalogEntry } from "./SatelliteCatalog";
import type { DesiredScene } from "./SatelliteManager";
import type { Observer } from "./SkyView";
import { repositioned } from "./util/groundStationEdits";
import { toMinuteIso } from "./util/urlCodec";
import { adjustUrlDefault, arrivalParam } from "./util/urlSync";

/** Enough to keep a fast clock multiplier from hammering the history api. */
const MIN_CLOCK_WRITE_MS = 1000;

/**
 * Active satellites above which a component is switched off. Labels become unreadable
 * on a 1080p globe; the ground station link costs about 8 µs per satellite a frame.
 */
const COMPONENT_BUDGETS: Record<string, number> = {
  Label: 200,
  "Ground station link": 500,
};

/** The part of `CesiumController` this file uses, so a test can stand in without WebGL. */
export interface SceneTarget {
  imageryLayers: string[];
  terrainProvider: string;
  cameraMode: string;
  pixelRatio: string;
  msaa: string;
  showFps: boolean;
  requestRenderMode: boolean;
  background: boolean;
  readonly skyView: {
    readonly active: boolean;
    enter(observer: Observer): Promise<void>;
    exit(): Promise<void>;
  };
  readonly skyInteraction: {
    start(): void;
    stop(): void;
    onObserverMove(callback: (observer: Observer) => void): void;
  };
  readonly sats: {
    reconcile(desired: DesiredScene): void;
    onTrackedChange(callback: (name: string) => void): void;
    onCatalogChange(callback: () => void): void;
    readonly catalog: { readonly entries: readonly CatalogEntry[] };
  };
  readonly viewer: {
    readonly clock: {
      readonly currentTime: JulianDate;
      readonly onTick: { addEventListener(listener: () => void): () => void };
    };
    readonly timeline?: unknown;
  };
  applySurfaceModel(surfaceModel: string, viewMode: string): Promise<void>;
  applyStarMap(starMap: string): Promise<void>;
  suppressCameraMode(): void;
  releaseCameraMode(): void;
  morphTo(mode: string): void;
  setTime(time: string): void;
}

export function startSceneSync(cc: SceneTarget): void {
  const cesiumStore = useCesiumStore();
  const satStore = useSatStore();

  // Immediate: the viewer has no base layer until this. Nothing may correct the stack
  // later, or it races the route preset's hydration (e2e/baseMap.spec.ts).
  watch(
    () => cesiumStore.layers,
    (layers) => {
      cc.imageryLayers = [...layers];
    },
    { deep: true, immediate: true },
  );
  watch(
    () => cesiumStore.terrainProvider,
    (name) => {
      cc.terrainProvider = name;
    },
  );
  // Not immediate: the viewer starts with the built-in sky box.
  watch(
    () => cesiumStore.starMap,
    (name) => {
      void applyStarMap(name);
    },
  );

  async function applyStarMap(name: string): Promise<void> {
    try {
      await cc.applyStarMap(name);
    } catch (error) {
      const recovery = starMapRecovery(name);
      console.warn(`Star map ${name} could not be loaded, falling back to ${BUILTIN_STAR_MAP}.${recovery ? ` Run \`${recovery}\` to build it.` : ""}`, error);
      // A newer switch may have overtaken the failed one. Writing the built-in over
      // itself is no change, so a failing built-in cannot loop.
      if (cesiumStore.starMap === name) {
        cesiumStore.starMap = BUILTIN_STAR_MAP;
      }
    }
  }
  // Immediate, because `?surface=` arrives before anything else triggers it.
  watch(
    () => [cesiumStore.surfaceModel, cesiumStore.sceneMode] as const,
    ([surfaceModel, viewMode]) => {
      void cc.applySurfaceModel(surfaceModel, viewMode);
    },
    { immediate: true },
  );
  // "Sky" needs an observer, so entering it can fail, and a refusal puts the mode back.
  let viewModeGeneration = 0;

  // The url echoes a refused `scene=Sky` back after the permission prompt, which
  // would ask the device again. A time window, because the echo lands within a
  // frame and a deliberate retry does not.
  const REFUSAL_ECHO_MS = 500;
  let refusedAt = Number.NEGATIVE_INFINITY;

  async function resolveObserver(): Promise<Observer | undefined> {
    // The stores hydrate independently: `?gs=` can land a tick after `?scene=`.
    await nextTick();
    const existing = satStore.groundStations[satStore.observerStation];
    if (existing) {
      return { lat: existing.lat, lon: existing.lon };
    }

    const fix = await currentPosition();
    if (!fix) {
      return undefined;
    }
    // The location becomes a ground station and the observer. Read it back rather
    // than reuse `fix`, so the observer is the rounded value the url holds.
    satStore.setGroundStations([...satStore.groundStations, { ...fix, name: "Geolocation" }]);
    satStore.setObserverStation(satStore.groundStations.length - 1);
    const created = satStore.groundStations[satStore.observerStation];
    return created ? { lat: created.lat, lon: created.lon } : undefined;
  }

  async function applyViewMode(mode: string, previous: string): Promise<void> {
    const generation = ++viewModeGeneration;

    if (mode !== SKY_MODE) {
      cc.skyInteraction.stop();
      // The camera is the sky view's until the flight back lands.
      await cc.skyView.exit();
      if (generation !== viewModeGeneration) {
        return;
      }
      cc.releaseCameraMode();
      cc.morphTo(mode);
      return;
    }

    const observer = await resolveObserver();
    if (generation !== viewModeGeneration) {
      return;
    }
    if (!observer) {
      console.warn("Sky view needs an observer: no ground station, and no location from the device");
      // Otherwise the radio just moves back, which reads as a broken control.
      useToastProxy().add({
        title: "Sky view needs a location",
        description: "Allow Geolocation or set a location from the Ground station menu.",
        color: "warning",
      });
      refusedAt = performance.now();
      cesiumStore.sceneMode = previous === SKY_MODE ? "3D" : previous;
      return;
    }

    // Inertial is suppressed, not cleared, so ?camera=Inertial survives. Tracking is
    // cleared: there is nothing to come back to (docs/adr/0003-sky-view.md).
    cc.suppressCameraMode();
    satStore.trackedSatellite = "";
    // Untrack first, so the sky view starts from a pose in world coordinates.
    await nextTick();
    if (generation !== viewModeGeneration) {
      return;
    }
    // Interaction waits for the descent: the aim is the flight's destination.
    await cc.skyView.enter(observer);
    if (generation !== viewModeGeneration) {
      return;
    }
    cc.skyInteraction.start();
  }

  watch(
    () => cesiumStore.sceneMode,
    (mode, previous) => {
      if (mode === SKY_MODE && performance.now() - refusedAt < REFUSAL_ECHO_MS) {
        refusedAt = Number.NEGATIVE_INFINITY;
        cesiumStore.sceneMode = previous === SKY_MODE ? "3D" : previous;
        return;
      }
      void applyViewMode(mode, previous);
    },
  );

  // Nothing is tracked under the sky view: `pendingTrackedSatellite` can resolve
  // long after entry. Write the store, not `viewer.trackedEntity`, or the two race.
  watch(
    () => satStore.trackedSatellite,
    (tracked) => {
      if (tracked !== "" && cc.skyView.active) {
        satStore.trackedSatellite = "";
      }
    },
  );

  // Moving or redesignating the observer's station moves a live sky view. Removing
  // every station leaves it where it is.
  watch(
    () => satStore.groundStations[satStore.observerStation],
    (station) => {
      if (station && cc.skyView.active) {
        // `enter` moves an active view without flying.
        void cc.skyView.enter({ lat: station.lat, lon: station.lon });
      }
    },
    { deep: true },
  );
  watch(
    () => cesiumStore.cameraMode,
    (mode) => {
      cc.cameraMode = mode;
    },
  );
  watch(
    () => cesiumStore.pixelRatio,
    (ratio) => {
      cc.pixelRatio = ratio;
    },
    { immediate: true },
  );
  watch(
    () => cesiumStore.msaa,
    (rate) => {
      cc.msaa = rate;
    },
    { immediate: true },
  );
  watch(
    () => cesiumStore.showFps,
    (show) => {
      cc.showFps = show;
    },
  );
  watch(
    () => cesiumStore.requestRenderMode,
    (on) => {
      cc.requestRenderMode = on;
    },
    { immediate: true },
  );
  watch(
    () => cesiumStore.background,
    (on) => {
      cc.background = on;
    },
  );

  // Asked of the catalog, so it is known before anything is built. Reads
  // catalogRevision so a lazily-loaded group re-runs it.
  const activeSatelliteCount = (): number => {
    void satStore.catalogRevision;
    return activeTargetEntries({
      entries: cc.sats.catalog.entries,
      enabledTags: satStore.enabledTags,
      enabledSatellites: satStore.enabledSatellites,
      disabledSatellites: satStore.disabledSatellites,
      trackedName: satStore.trackedSatellite || undefined,
    }).size;
  };

  // A store write, not a suppression, and edge-triggered on the crossing, so a user
  // who re-enables a component keeps it. A component named in `elements` stays on,
  // and over budget it leaves the url default so the url keeps naming it.
  const overBudget = new Set<string>();
  const withinBudget = (components: unknown): string[] => (components as string[]).filter((component) => !overBudget.has(component));
  watch(
    activeSatelliteCount,
    (count) => {
      const named = arrivalParam("elements")?.split(",") ?? [];
      let changed = false;
      for (const [component, budget] of Object.entries(COMPONENT_BUDGETS)) {
        if (count <= budget) {
          changed = overBudget.delete(component) || changed;
        } else if (!overBudget.has(component)) {
          overBudget.add(component);
          changed = true;
          if (!named.includes(component)) {
            satStore.enabledComponents = satStore.enabledComponents.filter((name) => name !== component);
          }
        }
      }
      if (changed) {
        adjustUrlDefault("sat", "enabledComponents", overBudget.size > 0 ? withinBudget : undefined);
      }
    },
    { immediate: true },
  );

  const desired = (): DesiredScene => ({
    enabledTags: [...satStore.enabledTags],
    enabledSatellites: [...satStore.enabledSatellites],
    disabledSatellites: [...satStore.disabledSatellites],
    components: [...satStore.enabledComponents],
    groundStations: satStore.groundStations.map((station) => ({ ...station })),
    overpassMode: satStore.overpassMode,
    trackedSatellite: satStore.trackedSatellite,
  });

  watch(desired, (next) => cc.sats.reconcile(next), { deep: true, immediate: true });

  // `time` is null (live) until the url or the clock deck pins it; then it follows the
  // clock to the minute.
  const clockMinute = (): string | undefined => toMinuteIso(JulianDate.toDate(cc.viewer.clock.currentTime));

  watch(
    () => cesiumStore.time,
    (pinned) => {
      if (pinned !== null && pinned !== (clockMinute() ?? null)) {
        cc.setTime(pinned);
      }
    },
    { immediate: true },
  );

  let lastClockWrite = 0;
  cc.viewer.clock.onTick.addEventListener(() => {
    if (cesiumStore.time === null) {
      return;
    }
    const now = performance.now();
    if (now - lastClockWrite < MIN_CLOCK_WRITE_MS) {
      return;
    }
    const minute = clockMinute();
    if (minute === cesiumStore.time) {
      return;
    }
    lastClockWrite = now;
    cesiumStore.setTime(minute ?? null);
  });

  cc.sats.onTrackedChange((name) => {
    satStore.trackedSatellite = name;
  });

  // A walk moves the observer's ground station, keeping its name and list position
  // (docs/adr/0003-sky-view.md).
  cc.skyInteraction.onObserverMove((observer) => {
    const at = satStore.observerStation;
    if (!satStore.groundStations[at]) {
      return;
    }
    satStore.setGroundStations(repositioned(satStore.groundStations, at, observer.lat, observer.lon));
  });

  // The catalog (~10k entries) is not reactive; the revision counter is.
  cc.sats.onCatalogChange(() => {
    satStore.catalogRevision += 1;
  });
}
