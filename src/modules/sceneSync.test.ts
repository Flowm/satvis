// What crosses the store→globe seam, against a fake `SceneTarget`.

import { JulianDate } from "@cesium/engine";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick } from "vue";

import { BUILTIN_STAR_MAP } from "../config/starMaps";
import { SKY_MODE } from "../config/viewModes";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import type { CatalogEntry } from "./SatelliteCatalog";
import type { DesiredScene } from "./SatelliteManager";
import { type SceneTarget, startSceneSync } from "./sceneSync";
import type { Observer } from "./SkyView";

/** The url the page was opened on. */
const url = vi.hoisted(() => ({ elements: undefined as string | undefined, adjustUrlDefault: vi.fn() }));
vi.mock("./util/urlSync", () => ({
  arrivalParam: (param: string) => (param === "elements" ? url.elements : undefined),
  adjustUrlDefault: url.adjustUrlDefault,
}));

/** Records what sceneSync writes. */
function fakeTarget() {
  const calls = {
    morphedTo: [] as string[],
    entered: [] as Observer[],
    exits: 0,
    interactionStarts: 0,
    interactionStops: 0,
    // A test calls it to simulate a walk.
    observerMoved: undefined as ((observer: Observer) => void) | undefined,
    suppressCamera: 0,
    releaseCamera: 0,
    reconciled: [] as DesiredScene[],
    surfaceModels: [] as [string, string][],
    starMaps: [] as string[],
    wentLive: 0,
  };

  const unavailableStarMaps = new Set<string>();
  const tickListeners: (() => void)[] = [];
  const clock = {
    currentTime: JulianDate.fromIso8601("2026-01-01T00:00:00Z"),
    onTick: {
      addEventListener: (listener: () => void) => {
        tickListeners.push(listener);
        return () => {};
      },
    },
  };

  const catalog = { entries: [] as CatalogEntry[] };

  const target: SceneTarget & { skyView: { active: boolean } } = {
    imageryLayers: [],
    terrainProvider: "None",
    cameraMode: "Fixed",
    pixelRatio: "native",
    msaa: "4",
    showFps: false,
    requestRenderMode: true,
    background: false,
    skyView: {
      active: false,
      enter(observer: Observer) {
        calls.entered.push(observer);
        this.active = true;
        return Promise.resolve();
      },
      exit() {
        calls.exits += 1;
        this.active = false;
        return Promise.resolve();
      },
    },
    skyInteraction: {
      unseen: "dim",
      start: () => {
        calls.interactionStarts += 1;
      },
      stop: () => {
        calls.interactionStops += 1;
      },
      onObserverMove: (callback) => {
        calls.observerMoved = callback;
      },
    },
    sats: {
      reconcile: (desired) => {
        calls.reconciled.push(desired);
      },
      onTrackedChange: () => {},
      onCatalogChange: () => {},
      catalog,
    },
    viewer: {
      clock,
      timeline: undefined,
    },
    applySurfaceModel: (surfaceModel, viewMode) => {
      calls.surfaceModels.push([surfaceModel, viewMode]);
      return Promise.resolve();
    },
    applyStarMap: (starMap) => {
      calls.starMaps.push(starMap);
      return unavailableStarMaps.has(starMap) ? Promise.reject(new Error("no faces")) : Promise.resolve();
    },
    suppressCameraMode: () => {
      calls.suppressCamera += 1;
    },
    releaseCameraMode: () => {
      calls.releaseCamera += 1;
    },
    morphTo: (mode) => {
      calls.morphedTo.push(mode);
    },
    setTime: () => {},
    goLive: () => {
      calls.wentLive += 1;
      clock.currentTime = JulianDate.fromDate(new Date());
    },
  };

  /** One frame of the viewer's clock. */
  const tick = () => tickListeners.forEach((listener) => listener());

  return { target, calls, catalog, unavailableStarMaps, clock, tick };
}

function entriesWithTag(tag: string, count: number): CatalogEntry[] {
  return Array.from({ length: count }, (_, i) => ({ key: `k${i}`, name: `SAT ${i}`, tags: [tag], metadata: {} }) as unknown as CatalogEntry);
}

/** Sequential: each tick of the view-mode await chain releases the next. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await nextTick();
  }
}

describe("startSceneSync", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    url.elements = undefined;
    url.adjustUrlDefault.mockClear();
  });

  test("plain settings travel from the store to the globe", async () => {
    const { target } = fakeTarget();
    startSceneSync(target);
    const store = useCesiumStore();

    store.terrainProvider = "CesiumWorldTerrain";
    store.cameraMode = "Inertial";
    store.showFps = true;
    store.background = false;
    store.unseen = "hide";
    await nextTick();

    expect(target.terrainProvider).toBe("CesiumWorldTerrain");
    expect(target.cameraMode).toBe("Inertial");
    expect(target.showFps).toBe(true);
    expect(target.skyInteraction.unseen).toBe("hide");
  });

  test("the star map is installed on request, and not before", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const store = useCesiumStore();

    // The viewer already has the built-in sky box.
    expect(calls.starMaps).toEqual([]);

    store.starMap = "DeepStar2K";
    await settle();

    expect(calls.starMaps).toEqual(["DeepStar2K"]);
    expect(store.starMap).toBe("DeepStar2K");
  });

  test("a star map whose faces are missing falls back, and the store follows", async () => {
    const { target, calls, unavailableStarMaps } = fakeTarget();
    unavailableStarMaps.add("DeepStar2K");
    startSceneSync(target);
    const store = useCesiumStore();

    store.starMap = "DeepStar2K";
    await settle();

    // The radio and the url read the store.
    expect(store.starMap).toBe(BUILTIN_STAR_MAP);
    expect(calls.starMaps).toEqual(["DeepStar2K", BUILTIN_STAR_MAP]);
  });

  test("a projection view mode morphs, and hands the camera back first", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const store = useCesiumStore();

    store.sceneMode = "2D";
    await settle();

    expect(calls.morphedTo).toEqual(["2D"]);
    expect(calls.exits).toBe(1);
    expect(calls.releaseCamera).toBe(1);
  });

  test("the sky view enters on the first ground station, and takes the camera", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const cesiumStore = useCesiumStore();
    const satStore = useSatStore();

    satStore.setGroundStations([{ lat: 48.1, lon: 11.6, name: "Munich" }]);
    cesiumStore.sceneMode = "Sky";
    await settle();

    expect(calls.entered).toEqual([{ lat: 48.1, lon: 11.6 }]);
    expect(calls.suppressCamera).toBe(1);
    expect(calls.interactionStarts).toBe(1);
    expect(cesiumStore.sceneMode).toBe("Sky");
  });

  test("with no ground station the sky view stands where the device is, kept first as Geolocation", async () => {
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (ok: (position: unknown) => void) => ok({ coords: { latitude: 47.26921, longitude: 11.40409 } }) } });
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const satStore = useSatStore();

    useCesiumStore().sceneMode = "Sky";
    await settle();

    expect(satStore.groundStations).toEqual([{ lat: 47.2692, lon: 11.4041, name: "Geolocation" }]);
    expect(satStore.observerStation).toBe(0);
    expect(calls.entered).toEqual([{ lat: 47.2692, lon: 11.4041 }]);
    vi.unstubAllGlobals();
  });

  test("with no observer available the sky view is refused and the mode goes back", async () => {
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => fail(new Error("denied")) } });
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const store = useCesiumStore();

    store.sceneMode = "Sky";
    await settle();

    expect(calls.entered).toEqual([]);
    expect(store.sceneMode).toBe("3D");
    vi.unstubAllGlobals();
  });

  test("a refusal answers the url's echo of it, rather than asking the device twice", async () => {
    // Writing the store stands in for the query watcher re-applying a stale `scene=Sky`.
    let asked = 0;
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => {
          asked += 1;
          fail(new Error("denied"));
        },
      },
    });
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const store = useCesiumStore();

    store.sceneMode = "Sky";
    await settle();
    expect(asked).toBe(1);
    expect(store.sceneMode).toBe("3D");

    store.sceneMode = "Sky";
    await settle();

    expect(asked).toBe(1);
    expect(store.sceneMode).toBe("3D");
    expect(calls.entered).toEqual([]);
    vi.unstubAllGlobals();
  });

  test("a deliberate retry is asked again, however the refusal was answered", async () => {
    let asked = 0;
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => {
          asked += 1;
          fail(new Error("denied"));
        },
      },
    });
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { target } = fakeTarget();
    startSceneSync(target);
    const store = useCesiumStore();

    store.sceneMode = "Sky";
    await settle();
    expect(asked).toBe(1);

    clock = 5000;
    store.sceneMode = "Sky";
    await settle();

    expect(asked).toBe(2);
    expect(store.sceneMode).toBe("3D");
    now.mockRestore();
    vi.unstubAllGlobals();
  });

  test("walking in the sky view moves the first ground station, and nothing else", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const satStore = useSatStore();
    satStore.setGroundStations([
      { lat: 48.1, lon: 11.6, name: "Munich" },
      { lat: 0, lon: 0, name: "Null Island" },
    ]);

    calls.observerMoved?.({ lat: 48.10123456, lon: 11.60987654 });
    await settle();

    // The store rounds the coordinates; the name stays.
    expect(satStore.groundStations).toEqual([
      { lat: 48.1012, lon: 11.6099, name: "Munich" },
      { lat: 0, lon: 0, name: "Null Island" },
    ]);
  });

  test("the sky view enters at the designated station, not the first one", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const satStore = useSatStore();
    const store = useCesiumStore();
    satStore.setGroundStations([
      { lat: 48.1, lon: 11.6, name: "Munich" },
      { lat: 47.27, lon: 11.39, name: "Innsbruck" },
    ]);
    satStore.setObserverStation(1);

    store.sceneMode = SKY_MODE;
    await settle();

    expect(calls.entered).toEqual([{ lat: 47.27, lon: 11.39 }]);
    expect(satStore.groundStations.map((station) => station.name)).toEqual(["Munich", "Innsbruck"]);
  });

  test("walking moves the designated station and leaves it where it is in the list", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const satStore = useSatStore();
    satStore.setGroundStations([
      { lat: 48.1, lon: 11.6, name: "Munich" },
      { lat: 47.27, lon: 11.39, name: "Innsbruck" },
    ]);
    satStore.setObserverStation(1);

    calls.observerMoved?.({ lat: 47.3, lon: 11.4 });
    await settle();

    expect(satStore.groundStations).toEqual([
      { lat: 48.1, lon: 11.6, name: "Munich" },
      { lat: 47.3, lon: 11.4, name: "Innsbruck" },
    ]);
  });

  test("designating another station moves a live sky view to it", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const satStore = useSatStore();
    const store = useCesiumStore();
    satStore.setGroundStations([
      { lat: 48.1, lon: 11.6, name: "Munich" },
      { lat: 47.27, lon: 11.39, name: "Innsbruck" },
    ]);

    store.sceneMode = SKY_MODE;
    await settle();
    expect(calls.entered).toEqual([{ lat: 48.1, lon: 11.6 }]);

    satStore.setObserverStation(1);
    await settle();

    expect(calls.entered.at(-1)).toEqual({ lat: 47.27, lon: 11.39 });
  });

  test("a station designated past the end of the list is refused", () => {
    const { target } = fakeTarget();
    startSceneSync(target);
    const satStore = useSatStore();
    satStore.setGroundStations([{ lat: 48.1, lon: 11.6, name: "Munich" }]);

    satStore.setObserverStation(4);

    expect(satStore.observerStation).toBe(0);
  });

  test("a walk with no ground station to move is dropped rather than inventing one", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const satStore = useSatStore();

    calls.observerMoved?.({ lat: 48.1, lon: 11.6 });
    await settle();

    expect(satStore.groundStations).toEqual([]);
  });

  test("nothing stays tracked while the sky view is up", async () => {
    const { target } = fakeTarget();
    startSceneSync(target);
    const satStore = useSatStore();
    target.skyView.active = true;

    satStore.trackedSatellite = "ISS";
    await nextTick();

    expect(satStore.trackedSatellite).toBe("");
  });

  test("the desired scene is handed over as plain data", async () => {
    const { target, calls } = fakeTarget();
    startSceneSync(target);
    const satStore = useSatStore();

    satStore.setActivation({ enabledTags: ["Weather"], enabledSatellites: ["ISS"] });
    await settle();

    const last = calls.reconciled.at(-1);
    expect(last?.enabledTags).toEqual(["Weather"]);
    expect(last?.enabledSatellites).toEqual(["ISS"]);
    // The manager diffs against what it was last given, so a live reference would equal itself.
    expect(last?.enabledTags).not.toBe(satStore.enabledTags);
  });

  describe("the component budgets", () => {
    /** A tag counts nothing until its group's entries land. */
    function loadGroup(catalog: { entries: CatalogEntry[] }, tag: string, count: number): void {
      catalog.entries = entriesWithTag(tag, count);
      useSatStore().catalogRevision += 1;
    }

    test("switches labels off once the activation crosses the threshold", async () => {
      const { target, catalog } = fakeTarget();
      startSceneSync(target);
      const satStore = useSatStore();
      expect(satStore.enabledComponents).toContain("Label");

      satStore.setActivation({ enabledTags: ["Starlink"] });
      loadGroup(catalog, "Starlink", 201);
      await settle();

      expect(satStore.enabledComponents).not.toContain("Label");
      expect(satStore.enabledComponents).toContain("Point");
    });

    test("leaves labels alone at the threshold", async () => {
      const { target, catalog } = fakeTarget();
      startSceneSync(target);
      const satStore = useSatStore();

      satStore.setActivation({ enabledTags: ["Weather"] });
      loadGroup(catalog, "Weather", 200);
      await settle();

      expect(satStore.enabledComponents).toContain("Label");
    });

    test("re-enabling sticks while the count stays over", async () => {
      const { target, catalog } = fakeTarget();
      startSceneSync(target);
      const satStore = useSatStore();

      satStore.setActivation({ enabledTags: ["Starlink"] });
      loadGroup(catalog, "Starlink", 201);
      await settle();
      expect(satStore.enabledComponents).not.toContain("Label");

      // The rule is a crossing, not a cap.
      satStore.enabledComponents = [...satStore.enabledComponents, "Label"];
      loadGroup(catalog, "Starlink", 5000);
      await settle();

      expect(satStore.enabledComponents).toContain("Label");
    });

    test("leaves labels on when the link opened with names them", async () => {
      url.elements = "Point,Label";
      const { target, catalog } = fakeTarget();
      startSceneSync(target);
      const satStore = useSatStore();

      satStore.setActivation({ enabledTags: ["Weather", "GNSS"] });
      loadGroup(catalog, "Weather", 267);
      await settle();

      expect(satStore.enabledComponents).toContain("Label");
    });

    test("keeps only the components the link names", async () => {
      url.elements = "Point,Ground station link";
      const { target, catalog } = fakeTarget();
      startSceneSync(target);
      const satStore = useSatStore();
      satStore.enabledComponents = ["Point", "Label", "Ground station link"];

      satStore.setActivation({ enabledTags: ["Starlink"] });
      loadGroup(catalog, "Starlink", 501);
      await settle();

      expect(satStore.enabledComponents).toEqual(["Point", "Ground station link"]);
    });

    test("drops Label from the url default while over, and restores it under", async () => {
      const { target, catalog } = fakeTarget();
      startSceneSync(target);
      const satStore = useSatStore();

      satStore.setActivation({ enabledTags: ["Starlink"] });
      loadGroup(catalog, "Starlink", 201);
      await settle();
      const [storeId, key, adjust] = url.adjustUrlDefault.mock.lastCall ?? [];
      expect([storeId, key]).toEqual(["sat", "enabledComponents"]);
      expect(adjust(["Point", "Label", "Orbit"])).toEqual(["Point", "Orbit"]);

      satStore.setActivation({ enabledTags: [] });
      await settle();
      expect(url.adjustUrlDefault).toHaveBeenLastCalledWith("sat", "enabledComponents", undefined);
    });

    test("fires again after the count drops back under and crosses anew", async () => {
      const { target, catalog } = fakeTarget();
      startSceneSync(target);
      const satStore = useSatStore();

      satStore.setActivation({ enabledTags: ["Starlink"] });
      loadGroup(catalog, "Starlink", 201);
      await settle();
      satStore.enabledComponents = [...satStore.enabledComponents, "Label"];

      satStore.setActivation({ enabledTags: [] });
      await settle();
      expect(satStore.enabledComponents).toContain("Label");

      satStore.setActivation({ enabledTags: ["Starlink"] });
      await settle();
      expect(satStore.enabledComponents).not.toContain("Label");
    });

    test("switches the ground station link off past its own, higher budget", async () => {
      const { target, catalog } = fakeTarget();
      startSceneSync(target);
      const satStore = useSatStore();
      satStore.enabledComponents = [...satStore.enabledComponents, "Ground station link"];

      satStore.setActivation({ enabledTags: ["Starlink"] });
      loadGroup(catalog, "Starlink", 500);
      await settle();
      expect(satStore.enabledComponents).toContain("Ground station link");
      expect(satStore.enabledComponents).not.toContain("Label");

      loadGroup(catalog, "Starlink", 501);
      await settle();
      expect(satStore.enabledComponents).not.toContain("Ground station link");
      expect(satStore.enabledComponents).toContain("Point");
    });

    test("switches 3D models off past 200 satellites that have one", async () => {
      const { target, catalog } = fakeTarget();
      startSceneSync(target);
      const satStore = useSatStore();
      satStore.enabledComponents = [...satStore.enabledComponents, "3D model"];
      const withModels = (count: number, total: number): CatalogEntry[] => {
        const entries = entriesWithTag("Starlink", total);
        entries.slice(0, count).forEach((entry) => Object.assign(entry, { metadata: { modelFile: "STARLINK-V1.glb" } }));
        return entries;
      };

      satStore.setActivation({ enabledTags: ["Starlink"] });
      catalog.entries = withModels(200, 1000);
      satStore.catalogRevision += 1;
      await settle();
      expect(satStore.enabledComponents).toContain("3D model");
      expect(satStore.enabledComponents).not.toContain("Label");

      catalog.entries = withModels(201, 1000);
      satStore.catalogRevision += 1;
      await settle();
      expect(satStore.enabledComponents).not.toContain("3D model");
      expect(satStore.enabledComponents).toContain("Point");
    });
  });

  describe("the url's time follows the Live dot", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date", "performance"], now: Date.parse("2026-01-01T00:00:00Z") });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    test("a live clock that leaves the present pins the url to the minute it shows", () => {
      const { target, clock, tick } = fakeTarget();
      startSceneSync(target);
      const store = useCesiumStore();

      vi.advanceTimersByTime(2000);
      tick();
      expect(store.time).toBeNull();

      // A pass link, a paused clock or 600× all move the clock away from the present.
      clock.currentTime = JulianDate.fromIso8601("2026-01-01T02:30:20Z");
      tick();
      expect(store.time).toBe("2026-01-01T02:30Z");
    });

    test("a pinned clock back at the present goes live", () => {
      const { target, clock, tick } = fakeTarget();
      startSceneSync(target);
      const store = useCesiumStore();
      store.setTime("2025-12-31T21:00Z");

      // Scrubbed back to the present: the deck shows Live, so the url must not pin.
      vi.advanceTimersByTime(2000);
      clock.currentTime = JulianDate.fromIso8601("2026-01-01T00:00:02Z");
      tick();
      expect(store.time).toBeNull();
    });

    test("a url that drops a pinned time takes the clock back to the present", async () => {
      const { target, calls, clock, tick } = fakeTarget();
      startSceneSync(target);
      const store = useCesiumStore();
      clock.currentTime = JulianDate.fromIso8601("2025-12-31T21:00:00Z");
      store.setTime("2025-12-31T21:00Z");
      await nextTick();

      // Back to a link without `time`, or a bookmark without one.
      store.setTime(null);
      await nextTick();
      expect(calls.wentLive).toBe(1);
      vi.advanceTimersByTime(2000);
      tick();
      expect(store.time).toBeNull();
    });

    test("the clock clearing the time at the present does not restart it", async () => {
      const { target, calls, clock, tick } = fakeTarget();
      startSceneSync(target);
      const store = useCesiumStore();
      store.setTime("2025-12-31T21:00Z");
      await nextTick();

      vi.advanceTimersByTime(2000);
      clock.currentTime = JulianDate.fromIso8601("2026-01-01T00:00:30Z");
      tick();
      await nextTick();
      expect(store.time).toBeNull();
      expect(calls.wentLive).toBe(0);
    });

    test("a clock within a minute of the present stays live", () => {
      const { target, clock, tick } = fakeTarget();
      startSceneSync(target);
      const store = useCesiumStore();

      vi.advanceTimersByTime(2000);
      clock.currentTime = JulianDate.fromIso8601("2026-01-01T00:00:50Z");
      tick();
      expect(store.time).toBeNull();
    });
  });
});
