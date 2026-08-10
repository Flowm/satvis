<template>
  <div class="cesium">
    <div v-show="showUI" id="toolbarLeft">
      <div class="toolbarButtons">
        <UTooltip text="Satellite selection">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('cat')">
            <UIcon name="lucide:satellite" />
          </button>
        </UTooltip>
        <UTooltip text="Satellite components">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('sat')">
            <UIcon name="lucide:orbit" />
          </button>
        </UTooltip>
        <UTooltip text="Ground station">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('gs')">
            <UIcon name="lucide:map-pin" />
          </button>
        </UTooltip>
        <UTooltip text="Map">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('map')">
            <UIcon name="lucide:layers" />
          </button>
        </UTooltip>
        <UTooltip text="View">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('view')">
            <UIcon name="lucide:telescope" />
          </button>
        </UTooltip>
        <UTooltip v-if="cc.minimalUI" text="Mobile">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('ios')">
            <UIcon name="lucide:smartphone" />
          </button>
        </UTooltip>
        <UTooltip text="Render">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('render')">
            <UIcon name="lucide:gauge" />
          </button>
        </UTooltip>
        <UTooltip text="GraphQL data">
          <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleMenu('gql')">
            <UIcon name="lucide:database" />
          </button>
        </UTooltip>
      </div>
      <!-- v-if (not v-show like the other panels): the virtualized list inside
           measures its scroll element on mount, and mounting hidden (display:none)
           yields a 0-height measurement that only a later ResizeObserver tick would
           fix. Mounting on open guarantees a correct first paint; browser state
           (search, expansion) is module-scoped in useSatelliteBrowser and survives
           remounts. -->
      <div v-if="menu.cat" class="toolbarSwitches toolbarSwitches--catalog">
        <satellite-browser />
      </div>
      <div v-show="menu.sat" class="toolbarSwitches">
        <!-- "Components", not "elements": an element set is the GP data a
             satellite is built from, and this panel is about what is drawn. -->
        <div class="toolbarTitle">Satellite components</div>
        <label v-for="componentName in cc.sats.availableComponents" :key="componentName" class="toolbarSwitch">
          <input v-model="enabledComponents" type="checkbox" :value="componentName" />
          <span class="slider"></span>
          {{ componentName }}
        </label>
        <!--
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.trackedEntity = undefined">
          Untrack Entity
        </label>
        -->
      </div>
      <div v-show="menu.gs" class="toolbarSwitches">
        <div class="toolbarTitle">Ground station</div>
        <ground-station-list />
        <div class="toolbarTitle">Overpass calculation</div>
        <label class="toolbarSwitch">
          <input v-model="overpassMode" type="radio" value="elevation" />
          <span class="slider"></span>
          Elevation
        </label>
        <label class="toolbarSwitch">
          <input v-model="overpassMode" type="radio" value="swath" />
          <span class="slider"></span>
          Swath
        </label>
      </div>
      <div v-show="menu.map" class="toolbarSwitches">
        <!-- The imagery is two groups rather than one list, each with the control
             its invariant deserves: at most one basemap, so radios, and any number
             of overlays, so checkboxes. Both bind by *provider* rather than by
             token, so a layer carrying an opacity (`ArcGis_0.5`, which only a url
             can set) still shows as the layer it is.

             Either group goes inert when a surface model has taken over what it
             describes. Dimmed, and still live: the selection is still the user's,
             it simply is not being drawn while the globe is hidden. The Terrain
             group below is the one exception, and says why. -->
        <div class="toolbarTitle" :class="{ 'toolbarTitle--inert': inert.includes('layers') }">Basemap</div>
        <label v-for="name in cc.baseLayers" :key="name" class="toolbarSwitch" :class="{ 'toolbarSwitch--inert': inert.includes('layers') }">
          <input type="radio" name="basemap" :value="name" :checked="baseLayer === name" @change="setBaseLayer(name)" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div class="toolbarTitle" :class="{ 'toolbarTitle--inert': inert.includes('layers') }">Overlays</div>
        <label v-for="name in cc.overlayLayers" :key="name" class="toolbarSwitch" :class="{ 'toolbarSwitch--inert': inert.includes('layers') }">
          <input type="checkbox" :checked="hasOverlay(name)" @change="toggleOverlay(name, ($event.target as HTMLInputElement).checked)" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div v-if="inertReason('layers')" class="toolbarNote">{{ inertReason("layers") }}</div>
        <div class="toolbarTitle" :class="{ 'toolbarTitle--inert': inert.includes('terrain') }">Terrain</div>
        <!-- `:checked` against what the globe is using rather than `v-model` against
             the store: while a surface model imposes a terrain, the stored choice is
             not the terrain being drawn, and a radio's dot is the app saying what
             is. Disabled only when imposed — the choice is genuinely not the user's
             then, and a control that accepts a click and shows nothing is worse than
             one that declines it. The store still remembers, and still comes back. -->
        <label v-for="name in cc.terrainProviderNames" :key="name" class="toolbarSwitch" :class="{ 'toolbarSwitch--inert': inert.includes('terrain') }">
          <input type="radio" name="terrain" :value="name" :checked="activeTerrain === name" :disabled="terrainImposed" @change="terrainProvider = name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <!-- Dimming says a group is not describing the picture; this says what is.
             Without it the Terrain group is the confusing case: the selected row is
             not what is in force, and nothing on screen names what is. -->
        <div v-if="inertReason('terrain')" class="toolbarNote">{{ inertReason("terrain") }}</div>
        <div class="toolbarTitle">Surface</div>
        <label v-for="name in SURFACE_MODELS" :key="name" class="toolbarSwitch">
          <input v-model="surfaceModel" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <!-- Only for the model actually selected: the note explains why nothing
             happened, and is noise against a model nobody asked for. -->
        <div v-if="surfaceUnavailable" class="toolbarNote">{{ surfaceUnavailable }}</div>
        <!-- Last, because it is the only group here that is about what is *behind*
             the globe rather than on it. See src/config/starMaps.ts for what each
             one is and what it costs.

             Narrowed to the maps actually on the server, the same way the pixel
             ratio ladder is narrowed to the rungs below this display: the
             non-builtin ones are optional assets, and a radio that selects a sky
             nobody can load is worse than one that is absent. The url vocabulary
             is not narrowed with it — `?stars=` still accepts every name. -->
        <div class="toolbarTitle">Star map</div>
        <label v-for="name in starMapOptions" :key="name" class="toolbarSwitch">
          <input v-model="starMap" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
      </div>
      <!-- Where you look from and with what, as against the Map panel's what you
           are looking at. -->
      <div v-show="menu.view" class="toolbarSwitches">
        <div class="toolbarTitle">View</div>
        <label v-for="name in cc.sceneModes" :key="name" class="toolbarSwitch">
          <input v-model="sceneMode" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <!-- Under the mode it belongs to, the same way the map panel's notes sit
             under the selection they explain: the keys work whether or not this
             says so, but nothing else in the app would say it. Hidden in
             minimalUI — the iOS and iframe case — where there is no keyboard to
             press and the panel is the smaller for it. -->
        <div v-if="inSkyView && !cc.minimalUI" class="toolbarNote">WASD walks the observer, Q and E change height.</div>
        <div class="toolbarTitle">Camera</div>
        <label v-for="name in cc.cameraModes" :key="name" class="toolbarSwitch">
          <input v-model="cameraMode" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <!-- Only in the sky view, which is the only place an aim exists to hand
             over, and only where the sensor could work at all. -->
        <template v-if="inSkyView && compassOffered">
          <div class="toolbarTitle">Aiming</div>
          <label class="toolbarSwitch">
            <input type="checkbox" :checked="compassActive" :disabled="compassPending" @change="onCompassToggle" />
            <!-- The spinner stands in for the slider rather than joining it: both
                 occupy the row's left gutter, and one of the two is always the
                 answer to "what is this control doing". -->
            <span v-if="compassPending" class="toolbarSpinner"></span>
            <span v-else class="slider"></span>
            Use compass
          </label>
        </template>
      </div>
      <div v-show="menu.ios" class="toolbarSwitches">
        <div class="toolbarTitle">Mobile</div>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.useWebVR" type="checkbox" />
          <span class="slider"></span>
          VR
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.clock.shouldAnimate" type="checkbox" />
          <span class="slider"></span>
          Play
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier *= 2" />
          Increase play speed
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="cc.viewer.clockViewModel.multiplier /= 2" />
          Decrease play speed
        </label>
        <label class="toolbarSwitch">
          <input type="button" @click="reload" />
          Reload
        </label>
      </div>
      <!-- Everything about how the globe is drawn, and what that costs. Four
           sections: what reports the cost, then the three kinds of thing that
           decide it — what is in the scene, how many pixels it is drawn into,
           and what each edge pixel costs. -->
      <div v-show="menu.render" class="toolbarSwitches">
        <div class="toolbarTitle">Measurement</div>
        <label class="toolbarSwitch">
          <input v-model="showFps" type="checkbox" />
          <span class="slider"></span>
          FPS
        </label>
        <!-- The benchmarking framework (src/modules/benchmark). Beneath FPS because it is the same
             question asked in more depth, and url-synced like the rest of this
             menu, so a benchmarking session is a link. -->
        <label class="toolbarSwitch">
          <input v-model="showBenchmark" type="checkbox" />
          <span class="slider"></span>
          Benchmark
        </label>
        <!-- Not a measurement itself, but the setting that decides whether there
             is one to be had: with render-on-demand on, the gap between frames
             measures how idle the loop is rather than what a scene costs. -->
        <label class="toolbarSwitch">
          <input v-model="requestRenderMode" type="checkbox" />
          <span class="slider"></span>
          RequestRender
        </label>
        <div class="toolbarTitle">Scene effects</div>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.fog.enabled" type="checkbox" />
          <span class="slider"></span>
          Fog
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.enableLighting" type="checkbox" />
          <span class="slider"></span>
          Lighting
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.highDynamicRange" type="checkbox" />
          <span class="slider"></span>
          HDR
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.showGroundAtmosphere" type="checkbox" />
          <span class="slider"></span>
          Atmosphere
        </label>
        <!-- The two halves of the same trade, in the order they multiply. Both
             are ladders rather than switches because both costs are smooth —
             see src/config/rendering.ts. -->
        <div class="toolbarTitle">Pixel ratio</div>
        <label v-for="ratio in pixelRatioOptions" :key="ratio" class="toolbarSwitch">
          <input v-model="pixelRatio" type="radio" :value="ratio" />
          <span class="slider"></span>
          {{ ratio === "native" ? `${devicePixelRatio.toFixed(1)}x (Native)` : `${Number(ratio).toFixed(1)}x` }}
        </label>
        <div class="toolbarTitle">Antialiasing (MSAA)</div>
        <label v-for="rate in MSAA_RATES" :key="rate" class="toolbarSwitch">
          <input v-model="msaa" type="radio" :value="rate" />
          <span class="slider"></span>
          {{ rate === "off" ? "Off" : `${rate}x` }}
        </label>
      </div>
      <!-- Satellite data through the GraphQL backend API, mounted on open like
           the catalog list so its virtualized content measures correctly. -->
      <div v-if="menu.gql" class="toolbarSwitches">
        <satellite-graphql-panel />
      </div>
    </div>
    <div id="toolbarRight">
      <about-dialog v-if="showUI" />
      <UTooltip v-if="showUI" text="Github">
        <a class="cesium-button cesium-toolbar-button" href="https://github.com/Flowm/satvis/" target="_blank" rel="noopener">
          <UIcon name="fa6-brands:github" />
        </a>
      </UTooltip>
      <UTooltip text="Toggle UI">
        <button type="button" class="cesium-button cesium-toolbar-button" @click="toggleUI">
          <UIcon name="lucide:eye" />
        </button>
      </UTooltip>
    </div>
    <!-- Deliberately outside the showUI toggle: the entity info replaces the
         Cesium InfoBox, which was visible with hidden UI and in minimalUI. -->
    <entity-info-panel />
    <sky-hud />
    <!-- Async, so nothing about it is in the
         bundle a normal visitor downloads. -->
    <benchmark-panel v-if="showBenchmark" @close="showBenchmark = false" />
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, defineAsyncComponent, onMounted, reactive, ref } from "vue";

import { useController } from "../composables/useController";
import { compassAvailable, useSkyCompass } from "../composables/useSkyCompass";
import { layerProvider } from "../config/layers";
import { MSAA_RATES, pixelRatiosFor } from "../config/rendering";
import { availableStarMaps, BUILTIN_STAR_MAP, type StarMapName } from "../config/starMaps";
import { type MapGroup, SURFACE_MODELS, type SurfaceModelName, surfaceEffects, viewModeNote } from "../config/surfaceModels";
import { SKY_MODE } from "../config/viewModes";
import { DeviceDetect } from "../modules/util/DeviceDetect";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import AboutDialog from "./AboutDialog.vue";
import EntityInfoPanel from "./EntityInfoPanel.vue";
import GroundStationList from "./GroundStationList.vue";
import SatelliteBrowser from "./SatelliteBrowser.vue";
import SkyHud from "./SkyHud.vue";

// GraphQL data panel (live /api/graphql worker, static snapshot fallback).
// Async so it stays out of the normal visitor bundle until opened.
const SatelliteGraphqlPanel = defineAsyncComponent(() => import("./SatelliteGraphqlPanel.vue"));

type MenuKey = "cat" | "sat" | "gs" | "map" | "view" | "ios" | "render" | "gql";

// The benchmarking framework. Async, so nothing about it — the sweep, the
// report tables, the panel — is in the bundle a normal visitor downloads.
const BenchmarkPanel = defineAsyncComponent(() => import("./BenchmarkPanel.vue"));

const cc = useController();

const menu = reactive<Record<MenuKey, boolean>>({
  cat: false,
  sat: false,
  gs: false,
  map: false,
  view: false,
  ios: false,
  render: false,
  gql: false,
});
const showUI = ref(true);

const cesiumStore = useCesiumStore();
const { layers, terrainProvider, surfaceModel, starMap, sceneMode, cameraMode, pixelRatio, msaa, showFps, showBenchmark, requestRenderMode } = storeToRefs(cesiumStore);

// Which star maps the Map menu offers. Starts at the one that cannot be missing
// so the group is never empty, and widens once the probes answer — a one-byte
// ranged GET each (never a HEAD; see `starMapAvailable`), resolved once per page
// rather than per menu open, so the list is settled long before anyone opens the
// panel.
const starMapOptions = ref<StarMapName[]>([BUILTIN_STAR_MAP]);
void availableStarMaps().then((names) => {
  starMapOptions.value = names;
});

// This display's own ratio: it names the `native` option and decides which of
// the fixed rungs are below it and so worth offering at all.
const devicePixelRatio = window.devicePixelRatio;
const pixelRatioOptions = pixelRatiosFor(devicePixelRatio);

// What the selection means here and now, from the one function the globe reads
// too — so a dimmed group and an unlit tileset cannot disagree.
const effects = computed(() => surfaceEffects(surfaceModel.value, sceneMode.value));
const inert = computed(() => effects.value.inert);

// The terrain the globe is actually using, and whether the user still owns the
// choice. A surface model that imposes one takes it over completely; a hidden
// globe does not — that choice is still theirs, it just is not being drawn yet.
const activeTerrain = computed(() => effects.value.terrain ?? terrainProvider.value);
const terrainImposed = computed(() => effects.value.terrain !== undefined);

// Why a group stopped describing the picture. Two different answers, and the
// distinction matters: an overridden terrain is still being drawn, just not the
// one the radio says, while a hidden globe is drawing neither.
//
// The imposed case also names the terrain that comes back, because the radio is
// showing what is in force rather than what the user picked — so without this
// their own choice would be stated nowhere at all.
function inertReason(group: MapGroup): string {
  if (!inert.value.includes(group)) {
    return "";
  }
  const forced = effects.value.terrain;
  if (group === "terrain" && forced) {
    return forced === terrainProvider.value ? `${surfaceModel.value} needs ${forced}` : `${surfaceModel.value} needs ${forced}, ${terrainProvider.value} returns`;
  }
  return `Hidden by ${surfaceModel.value}`;
}

// Named rather than merely flagged: "nothing happened" is the question this
// answers, and which view modes would have worked is the answer — derived from
// the rules themselves, never written out here, so widening one cannot leave this
// sentence asserting a restriction that is gone.
const surfaceUnavailable = computed(() => {
  if (surfaceModel.value === "None" || !effects.value.unavailable.includes(surfaceModel.value as SurfaceModelName)) {
    return "";
  }
  return viewModeNote(surfaceModel.value);
});

// The imagery stack, read and written a group at a time. `layers` is read-only
// because "at most one base layer" is an invariant of the list rather than of any
// one entry, so every write goes through the action that enforces it — and list
// order is z-order, which is why a basemap goes under and an overlay goes on top.
const isBaseToken = (token: string): boolean => {
  const provider = layerProvider(token);
  return provider !== undefined && cc.baseLayers.includes(provider);
};

/** The basemap in the stack, by provider name, or "" when a url left none. */
const baseLayer = computed(() => {
  const token = layers.value.find(isBaseToken);
  return token === undefined ? "" : (layerProvider(token) ?? "");
});

const hasOverlay = (name: string): boolean => layers.value.some((token) => layerProvider(token) === name);

function setBaseLayer(name: string): void {
  cesiumStore.setLayers([name, ...layers.value.filter((token) => !isBaseToken(token))]);
}

function toggleOverlay(name: string, enabled: boolean): void {
  const without = layers.value.filter((token) => layerProvider(token) !== name);
  cesiumStore.setLayers(enabled ? [...without, name] : without);
}

const satStore = useSatStore();
const { enabledComponents, overpassMode } = storeToRefs(satStore);

const compassOffered = compassAvailable();
const { active: compassActive, pending: compassPending, toggle: toggleCompass } = useSkyCompass(cc);
const inSkyView = computed(() => sceneMode.value === SKY_MODE);

// Handing the aim to a sensor is an action with an outcome, and the outcome may be
// "no". The browser's own flip on click is the feedback that something was
// attempted — and iOS's permission prompt has to be raised from inside the click —
// so the switch moves first and is corrected afterwards.
//
// The correction has to be made by hand. Vue re-syncs a checkbox only when the value
// bound to it changes, and a refused sensor leaves `compassActive` exactly where it
// was, so the box would sit there checked and contradicting it.
async function onCompassToggle(event: Event): Promise<void> {
  await toggleCompass();
  (event.target as HTMLInputElement).checked = compassActive.value;
  // Success closes the panel, which was covering the sky it was just asked to aim
  // at — so the revert above is only ever seen when it means something.
  if (compassActive.value) {
    menu.view = false;
  }
}

onMounted(() => {
  showUI.value = !DeviceDetect.inIframe();
});

function toggleMenu(name: MenuKey) {
  const oldState = menu[name];
  (Object.keys(menu) as MenuKey[]).forEach((k) => {
    menu[k] = false;
  });
  menu[name] = !oldState;
}

function toggleUI() {
  showUI.value = !showUI.value;
  if (!cc.minimalUI) {
    cc.showUI = showUI.value;
  }
}

function reload() {
  window.location.reload();
}
</script>
