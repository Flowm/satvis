import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { layerProvider } from "../config/layers";
import { FRAME_RATES, type FrameRate, MSAA_RATES, PIXEL_RATIOS, currentDevicePixelRatio, defaultMsaaRate } from "../config/rendering";
import { BUILTIN_STAR_MAP, STAR_MAPS } from "../config/starMaps";
import { SURFACE_MODELS } from "../config/surfaceModels";
import { CAMERA_MODES, SCENE_MODES, SKY_MODE } from "../config/viewModes";
import { baseLayerNames, imageryProviderNames, terrainProviderNames } from "../modules/CesiumLayerProviders";
import { sameValue } from "../modules/util/equality";
import { boolean, enumString, layerList, timestamp, toMinuteIso } from "../modules/util/urlCodec";
import { UNSEEN_MODES, type UnseenMode } from "../modules/util/visibility";

export const useCesiumStore = defineStore(
  "cesium",
  () => {
    const terrainProvider = ref("None");
    /** What a selection implies is derived in surfaceEffects, not stored. */
    const surfaceModel = ref("None");
    const starMap = ref<string>(BUILTIN_STAR_MAP);
    const sceneMode = ref("3D");
    /** In the sky view, what to do with the satellites that cannot be seen. */
    const unseen = ref<UnseenMode>("dim");
    const cameraMode = ref("Fixed");
    /** `native` is the display's own ratio. */
    const pixelRatio = ref<string>("native");
    /**
     * The default is read once, so moving to another monitor cannot overwrite the user's choice.
     */
    const msaa = ref<string>(defaultMsaaRate(currentDevicePixelRatio()));
    /** Frames a second at most; 60, as on iOS, spares the battery. */
    const frameRate = ref<FrameRate>("60");
    const background = ref(true);
    const showFps = ref(false);
    const pickMode = ref(false);
    /**
     * Matches createViewer. Held here because the scene property is not reactive. Not URL-synced.
     */
    const requestRenderMode = ref(true);
    /** The benchmark panel (src/modules/benchmark). */
    const showBenchmark = ref(false);

    // Read-only, so setLayers enforces "at most one base layer".
    const activeLayers = ref<string[]>(["NaturalEarth"]);
    const layers = computed(() => activeLayers.value);

    // null is live; a value is pinned. Read-only so the minute rounding cannot be skipped (CONTEXT.md).
    const pinnedTime = ref<string | null>(null);
    const time = computed(() => pinnedTime.value);

    function setTime(value: string | null): void {
      const next = value === null ? null : (toMinuteIso(value) ?? null);
      if (next !== pinnedTime.value) {
        pinnedTime.value = next;
      }
    }

    const bases = new Set(baseLayerNames());
    // By provider, so `ArcGis_0.5` is a basemap too.
    const isBase = (layer: string): boolean => bases.has(layerProvider(layer) ?? "");

    /** Drops unknown providers; the last base layer wins. List order is z-order. */
    function setLayers(next: readonly string[]): void {
      const known = new Set(imageryProviderNames());
      // An unusable opacity is dropped too: it would reach Cesium as NaN.
      const valid = next.filter((layer) => {
        const provider = layerProvider(layer);
        return provider !== undefined && known.has(provider);
      });
      const lastBase = valid.reduce((last, layer, index) => (isBase(layer) ? index : last), -1);
      const resolved = valid.filter((layer, index) => !isBase(layer) || index === lastBase);

      if (!sameValue(resolved, activeLayers.value)) {
        activeLayers.value = resolved;
      }
    }

    /** The basemap in the stack, by provider name, or "" when a url left none. */
    const baseLayer = computed(() => {
      const token = activeLayers.value.find(isBase);
      return token === undefined ? "" : (layerProvider(token) ?? "");
    });

    /** By provider, so an overlay with an opacity matches. */
    function hasOverlay(name: string): boolean {
      return activeLayers.value.some((token) => layerProvider(token) === name);
    }

    /** The basemap goes first, under the overlays, replacing the old one and its opacity. */
    function setBaseLayer(name: string): void {
      setLayers([name, ...activeLayers.value.filter((token) => !isBase(token))]);
    }

    /**
     * A panel's way into the sky view, with the terrain on, as the horizon is the
     * view's point; a terrain already chosen stays, as does one turned off in the
     * view. A link keeps its own.
     */
    function enterSkyView(): void {
      if (sceneMode.value !== SKY_MODE && terrainProvider.value === "None") {
        terrainProvider.value = "ReEarth";
      }
      sceneMode.value = SKY_MODE;
    }

    /** An overlay goes last, over the others. */
    function toggleOverlay(name: string, enabled: boolean): void {
      const without = activeLayers.value.filter((token) => layerProvider(token) !== name);
      setLayers(enabled ? [...without, name] : without);
    }

    return {
      layers,
      setLayers,
      baseLayer,
      hasOverlay,
      setBaseLayer,
      toggleOverlay,
      time,
      setTime,
      terrainProvider,
      surfaceModel,
      starMap,
      sceneMode,
      enterSkyView,
      unseen,
      cameraMode,
      pixelRatio,
      msaa,
      frameRate,
      background,
      showFps,
      pickMode,
      showBenchmark,
      requestRenderMode,
    };
  },
  {
    // Wire format: docs/adr/0001-url-parameter-specification.md.
    urlsync: {
      config: [
        { name: "layers", url: "layers", kind: layerList(imageryProviderNames) },
        { name: "terrainProvider", url: "terrain", kind: enumString(terrainProviderNames()) },
        { name: "surfaceModel", url: "surface", kind: enumString(SURFACE_MODELS) },
        { name: "starMap", url: "stars", kind: enumString([...STAR_MAPS]) },
        { name: "sceneMode", url: "scene", kind: enumString(SCENE_MODES) },
        { name: "unseen", url: "unseen", kind: enumString([...UNSEEN_MODES]) },
        { name: "cameraMode", url: "camera", kind: enumString(CAMERA_MODES) },
        { name: "pixelRatio", url: "pixelratio", kind: enumString([...PIXEL_RATIOS]) },
        { name: "msaa", url: "msaa", kind: enumString([...MSAA_RATES]) },
        { name: "frameRate", url: "framerate", kind: enumString([...FRAME_RATES]) },
        { name: "showFps", url: "fps", kind: boolean() },
        { name: "showBenchmark", url: "bench", kind: boolean() },
        { name: "background", url: "bg", kind: boolean() },
        { name: "time", url: "time", kind: timestamp() },
      ],
      // Only the guarded keys are named; everything else is a plain ref.
      apply(store, patch) {
        const { layers, time, ...free } = patch;
        Object.assign(store, free);
        store.setLayers(layers as string[]);
        store.setTime(time as string | null);
      },
    },
  },
);
