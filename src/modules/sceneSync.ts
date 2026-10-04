// The one place store state becomes globe state.
//
// This used to be fourteen watchers inside Satvis.vue, which had to be an
// always-mounted component for them to survive the catalog panel closing, and
// which quietly made "EntityInfoPanel is a child of Satvis" load-bearing —
// useSelectedEntity depended on being registered after Satvis's overpassMode
// watcher. Started from app.ts instead, none of that matters.
//
// The direction is one-way. The store decides, Cesium follows. Two values also
// travel the other way, both because the user moves them on the globe itself and
// both arriving as callbacks: the tracked satellite, which is started by clicking
// one, and the observer, which the sky view's movement keys walk.

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

// Enough to keep a fast clock multiplier from hammering the history api.
const MIN_CLOCK_WRITE_MS = 1000;

// Above these many active satellites a component is switched off for the user
// (see the watcher that applies it). Labels stop resolving into readable text on
// a 1080p globe; the ground station link costs about 8 µs per satellite a frame.
const COMPONENT_BUDGETS: Record<string, number> = {
  Label: 200,
  "Ground station link": 500,
};

/**
 * Everything this file touches on the globe, and nothing else.
 *
 * Declared structurally rather than as `CesiumController`, which is a 43-member
 * class that cannot be constructed without a WebGL context. What crosses this
 * seam is eighteen members, and writing them down is what says which parts of the
 * controller are load-bearing here — and what a test would have to stand in for.
 */
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
    // Read to size an activation before it is reconciled — how many satellites
    // a set of tags implies is a question about the catalog, not about what is
    // currently on the globe.
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

  // Immediate, because the store is the only owner of the layer stack: the viewer is
  // constructed with no base layer at all and the first stack arrives here.
  //
  // Nothing corrects the stack afterwards, which is what keeps this safe to run
  // immediately — an async correction racing the route preset's hydration is how it
  // used to clobber the preset's basemap (docs/manual-verification.md).
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
  // Not immediate, unlike the render settings: the viewer is constructed with
  // exactly the built-in sky box, so there is nothing to bring into line until
  // the value moves, and a link that names it fetches nothing.
  //
  // Unlike the base map, this one still needs a fallback. The base map's shallow
  // levels are committed, so its only question is how deep to go and the provider
  // answers it for itself. A sky box has no such floor: the faces are either built
  // or absent, so the failure arrives here as a rejection and something has to put
  // the built-in back.
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
      // The recovery hint travels with the path in starMaps.ts rather than being
      // written here, because it differs per map and this warning is the only
      // thing the reader gets.
      const recovery = starMapRecovery(name);
      console.warn(`Star map ${name} could not be loaded, falling back to ${BUILTIN_STAR_MAP}.${recovery ? ` Run \`${recovery}\` to build it.` : ""}`, error);
      // Read back rather than assuming: a second switch while the faces were in
      // flight has already asked for something else, and the one that failed is
      // no longer what anybody wants. Writing the built-in re-enters this
      // watcher, which is what puts it on the globe — and writing it over itself
      // is not a change, so a built-in that somehow fails cannot loop here.
      if (cesiumStore.starMap === name) {
        cesiumStore.starMap = BUILTIN_STAR_MAP;
      }
    }
  }
  // Both arguments, one watcher: what a surface model does depends on the view
  // mode as much as on the selection, and there is nothing to gain from
  // discovering which of the two moved. Immediate, because `?surface=` arrives
  // before anything else would trigger it.
  watch(
    () => [cesiumStore.surfaceModel, cesiumStore.sceneMode] as const,
    ([surfaceModel, viewMode]) => {
      void cc.applySurfaceModel(surfaceModel, viewMode);
    },
    { immediate: true },
  );
  // The view mode is the one setting that cannot be a plain assignment. Three
  // of the four are a Cesium projection, but "Sky" needs an observer, which may
  // still be arriving from the url or may have to be asked for — so entering is
  // an action with a result, and a refusal has to put the mode back.
  let viewModeGeneration = 0;

  // When the sky view was last refused for want of an observer, and how long that
  // answer stands for.
  //
  // It has to stand for something, because the url is a second writer of the view
  // mode and it echoes. The refused switch reaches the query before the mode is
  // put back — the mode is only put back once the browser has answered about the
  // location, which is a permission prompt away — and that navigation then applies
  // `scene=Sky` from behind, out of a url that is a step out of date. Left alone
  // it asks the device a second time and raises a second toast, for one click.
  //
  // Time, rather than a flag that a genuine second attempt would have to clear:
  // the echo is a round trip through the router and lands within a frame, while a
  // person reaching for the radio again does not. Consumed when it answers, so
  // the guard is never more than the one echo wide.
  const REFUSAL_ECHO_MS = 500;
  let refusedAt = Number.NEGATIVE_INFINITY;

  async function resolveObserver(): Promise<Observer | undefined> {
    // The cesium and sat stores hydrate from the url independently, so a ground
    // station in `?gs=` can land a tick after the view mode in `?scene=` does.
    // Waiting is the difference between using the observer the link supplied and
    // prompting for a location on top of it.
    await nextTick();
    const existing = satStore.groundStations[satStore.observerStation];
    if (existing) {
      return { lat: existing.lat, lon: existing.lon };
    }

    const fix = await currentPosition();
    if (!fix) {
      return undefined;
    }
    // The device's location becomes a ground station rather than a private
    // second notion of "here": the sky view's next-pass figures are then the
    // passes the app was already computing. Read it back rather than reusing
    // `fix`, so the observer is the rounded value the store and url agree on.
    satStore.setGroundStations([...satStore.groundStations, { ...fix, name: "Geolocation" }]);
    // And it becomes the observer, not merely a station. It was created to answer
    // "where is the sky view standing". Leaving the designation on whatever was
    // already first would open the view somewhere nobody just asked for.
    satStore.setObserverStation(satStore.groundStations.length - 1);
    const created = satStore.groundStations[satStore.observerStation];
    return created ? { lat: created.lat, lon: created.lon } : undefined;
  }

  async function applyViewMode(mode: string, previous: string): Promise<void> {
    const generation = ++viewModeGeneration;

    if (mode !== SKY_MODE) {
      cc.skyInteraction.stop();
      // The flight back up to the globe is the descent reversed, and until it
      // lands the camera is still the sky view's. Morphing the projection or
      // handing the camera back to the camera mode mid-flight would take it away
      // underneath, so both wait — and a switch straight back into the sky turns
      // the flight around, which makes this answer one about a view that never
      // left.
      await cc.skyView.exit();
      if (generation !== viewModeGeneration) {
        return;
      }
      cc.releaseCameraMode();
      cc.morphTo(mode);
      return;
    }

    const observer = await resolveObserver();
    // Leaving again while the browser was asking for a location, or a second
    // switch overtaking this one, makes this answer stale.
    if (generation !== viewModeGeneration) {
      return;
    }
    if (!observer) {
      console.warn("Sky view needs an observer: no ground station, and no location from the device");
      // Said out loud, because the whole of what happens otherwise is a radio
      // button moving back by itself — which reads as a broken control rather
      // than as a refusal. The way out is named: the device is one source of an
      // observer and the ground station menu is the other, and the second one
      // needs no permission from anybody.
      useToastProxy().add({
        title: "Sky view needs a location",
        description: "Allow Geolocation or set a location from the Ground station menu.",
        color: "warning",
      });
      refusedAt = performance.now();
      cesiumStore.sceneMode = previous === SKY_MODE ? "3D" : previous;
      return;
    }

    // Both of these fight the sky view for the camera, and they are handled
    // differently on purpose — see docs/adr/0003-sky-view.md. Inertial is
    // suppressed, so `?camera=Inertial` survives the round trip. Tracking is
    // cleared, because a camera cannot both follow a satellite and be a pair of
    // eyes on the ground, so there is nothing to come back to.
    cc.suppressCameraMode();
    satStore.trackedSatellite = "";
    // Looking around waits for the descent to land. Both the drag and the device
    // sensor write the aim, and the aim is the flight's destination — a gesture
    // during the descent would steer it rather than move a view that has
    // arrived, and there is nothing recognisable on screen to aim with yet.
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
        // The echo of a refusal this recent is the url catching up, not a second
        // ask. Put the mode back without asking the device again, and consume the
        // refusal so a deliberate retry is answered properly.
        refusedAt = Number.NEGATIVE_INFINITY;
        cesiumStore.sceneMode = previous === SKY_MODE ? "3D" : previous;
        return;
      }
      void applyViewMode(mode, previous);
    },
  );

  // Nothing is tracked while the sky view is up, held as a standing invariant
  // rather than a one-off clear on entry. A track can arrive later than the
  // view mode does: `pendingTrackedSatellite` resolves whenever its group
  // finishes loading, which can be long after. Writing the store rather than
  // `viewer.trackedEntity` matters — tracking is the one value the globe
  // reports back, so poking Cesium would reach the store from behind and race
  // the forward path.
  watch(
    () => satStore.trackedSatellite,
    (tracked) => {
      if (tracked !== "" && cc.skyView.active) {
        satStore.trackedSatellite = "";
      }
    },
  );

  // Moving the observer's ground station moves the observer under a live sky view,
  // and so does designating a different station. Both ask the same question — where
  // does the sky view stand now — so one watcher answers both.
  // Removing every station does not close it: the view stays where it was
  // rather than collapsing out from under someone editing their stations.
  watch(
    () => satStore.groundStations[satStore.observerStation],
    (station) => {
      if (station && cc.skyView.active) {
        // A move, which `enter` does without flying — the promise is only about
        // a flight, and there is none to wait for here.
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
  // Immediate, for the same reason as render-on-demand below: a url that asks
  // for `msaa=off` should be in force from the first frame rather than after
  // the first time the control is touched.
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
  // Immediate, so the store's value is the one in force from the first frame
  // rather than whatever the viewer was constructed with.
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

  // How many satellites the current activation implies, asked of the catalog
  // rather than of the globe so the answer is available before anything is
  // built. Touches catalogRevision so a lazily-loaded group re-runs it as its
  // entries land — enabling a tag counts 0 until then.
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

  // Labels stop being readable long before they stop being drawn: past a couple
  // of hundred they overlap into a mass that hides the globe and says nothing.
  // The ground station link is an entity per satellite. Switch each off as the
  // count crosses its budget.
  //
  // A real store write, not a suppression — the checkbox unticks, the url
  // follows, and turning one back on at 5,000 satellites is the user's call
  // to make and it sticks. Edge-triggered for exactly that reason: it fires on
  // the crossing, so re-enabling survives every later change that leaves the
  // count above the budget, and only a drop back under and a fresh crossing
  // switches it off again.
  //
  // A link that names a component has made that call already, so the crossing its
  // own activation causes leaves it on. Over its budget a component is not in the
  // default, which is what keeps `elements` naming it in the url to be shared on.
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

  // Live by default: `time` is null and absent from the url, so a shared link
  // opens at the recipient's present. It pins on a deliberate act — a time in
  // the url, or the user scrubbing the clock deck's ruler, which writes the
  // store itself — and then follows the clock at minute granularity so the link
  // reproduces the moment being looked at.
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

  // Walking in the sky view moves the observer, and the observer is a ground
  // station. So a walk lands here rather than in a private position of its own. The
  // pin, the pass predictions and `?gs=` all follow it
  // (docs/adr/0003-sky-view.md).
  //
  // The station keeps its name and its place in the list. Whoever the observer was
  // — "Home", or the geolocation fix that opened the view — is who they still are,
  // somewhere else; and a walk is not a reason to reorder anybody's stations.
  cc.skyInteraction.onObserverMove((observer) => {
    const at = satStore.observerStation;
    if (!satStore.groundStations[at]) {
      return;
    }
    satStore.setGroundStations(repositioned(satStore.groundStations, at, observer.lat, observer.lon));
  });

  // The catalog is deliberately non-reactive — ~10k entries do not belong in
  // Pinia — so a revision counter is what lets catalog-derived views recompute.
  cc.sats.onCatalogChange(() => {
    satStore.catalogRevision += 1;
  });
}
