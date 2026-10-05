<template>
  <div class="cesium">
    <div v-show="showUI" id="toolbarLeft">
      <div class="toolbarButtons">
        <UTooltip text="Satellite selection">
          <button type="button" class="cesium-button cesium-toolbar-button" :class="{ 'toolbarButton--open': menu.cat }" @click="toggleMenu('cat')">
            <UIcon name="lucide:satellite" />
          </button>
        </UTooltip>
        <UTooltip text="Satellite components">
          <button type="button" class="cesium-button cesium-toolbar-button" :class="{ 'toolbarButton--open': menu.sat }" @click="toggleMenu('sat')">
            <UIcon name="lucide:orbit" />
          </button>
        </UTooltip>
        <UTooltip text="Ground station">
          <button type="button" class="cesium-button cesium-toolbar-button" :class="{ 'toolbarButton--open': menu.gs }" @click="toggleMenu('gs')">
            <UIcon name="lucide:map-pin" />
          </button>
        </UTooltip>
        <UTooltip text="Map">
          <button type="button" class="cesium-button cesium-toolbar-button" :class="{ 'toolbarButton--open': menu.map }" @click="toggleMenu('map')">
            <UIcon name="lucide:layers" />
          </button>
        </UTooltip>
        <UTooltip text="View">
          <button type="button" class="cesium-button cesium-toolbar-button" :class="{ 'toolbarButton--open': menu.view }" @click="toggleMenu('view')">
            <UIcon name="lucide:telescope" />
          </button>
        </UTooltip>
        <UTooltip v-if="cc.minimalUI" text="Mobile">
          <button type="button" class="cesium-button cesium-toolbar-button" :class="{ 'toolbarButton--open': menu.ios }" @click="toggleMenu('ios')">
            <UIcon name="lucide:smartphone" />
          </button>
        </UTooltip>
        <UTooltip text="Render">
          <button type="button" class="cesium-button cesium-toolbar-button" :class="{ 'toolbarButton--open': menu.render }" @click="toggleMenu('render')">
            <UIcon name="lucide:gauge" />
          </button>
        </UTooltip>
      </div>
      <!-- v-if, not v-show: the virtualized list measures its scroll element on mount,
           and a hidden mount measures 0. Search and expansion state survive remounts in useSatelliteBrowser. -->
      <div v-if="menu.cat" class="toolbarSwitches toolbarSwitches--catalog">
        <satellite-browser />
      </div>
      <div v-show="menu.sat" class="toolbarSwitches">
        <!-- "Components", not "elements": an element set is the GP data. -->
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
      </div>
      <div v-show="menu.map" class="toolbarSwitches">
        <!-- Both groups bind by provider, not token, so a url layer with an opacity
             (`ArcGis_0.5`) still matches. An inert group is dimmed but stays live. -->
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
        <!-- `:checked` shows the terrain in force, not the stored choice, which an
             imposing surface model overrides; disabled while imposed. -->
        <label v-for="name in cc.terrainProviderNames" :key="name" class="toolbarSwitch" :class="{ 'toolbarSwitch--inert': inert.includes('terrain') }">
          <input type="radio" name="terrain" :value="name" :checked="activeTerrain === name" :disabled="terrainImposed" @change="terrainProvider = name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div v-if="inertReason('terrain')" class="toolbarNote">{{ inertReason("terrain") }}</div>
        <div class="toolbarTitle">Surface</div>
        <label v-for="name in SURFACE_MODELS" :key="name" class="toolbarSwitch">
          <input v-model="surfaceModel" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div v-if="surfaceUnavailable" class="toolbarNote">{{ surfaceUnavailable }}</div>
        <!-- Narrowed to the maps on the server (see src/config/starMaps.ts); `?stars=` still accepts every name. -->
        <div class="toolbarTitle">Star map</div>
        <label v-for="name in starMapOptions" :key="name" class="toolbarSwitch">
          <input v-model="starMap" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
      </div>
      <div v-show="menu.view" class="toolbarSwitches">
        <div class="toolbarTitle">View</div>
        <label v-for="name in cc.sceneModes" :key="name" class="toolbarSwitch">
          <input v-model="sceneMode" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <!-- Hidden in minimalUI (iOS, iframe), where there is no keyboard. -->
        <div v-if="inSkyView && !cc.minimalUI" class="toolbarNote">WASD walks the observer, Q and E change height.</div>
        <div class="toolbarTitle">Camera</div>
        <label v-for="name in cc.cameraModes" :key="name" class="toolbarSwitch">
          <input v-model="cameraMode" type="radio" :value="name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <template v-if="inSkyView && compassOffered">
          <div class="toolbarTitle">Aiming</div>
          <label class="toolbarSwitch">
            <input type="checkbox" :checked="compassActive" :disabled="compassPending" @change="onCompassToggle" />
            <!-- The spinner replaces the slider: both occupy the row's left gutter. -->
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
      <div v-show="menu.render" class="toolbarSwitches">
        <div class="toolbarTitle">Measurement</div>
        <label class="toolbarSwitch">
          <input v-model="showFps" type="checkbox" />
          <span class="slider"></span>
          FPS
        </label>
        <label class="toolbarSwitch">
          <input v-model="showBenchmark" type="checkbox" />
          <span class="slider"></span>
          Benchmark
        </label>
        <!-- Under Measurement: with render-on-demand on, frame gaps measure idleness, not scene cost. -->
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
        <!-- Ladders rather than switches; see src/config/rendering.ts. -->
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
    <!-- Outside showUI: it stays visible with hidden UI and in minimalUI. -->
    <entity-info-panel />
    <sky-hud />
    <!-- Pause, speed and scrubbing; `createViewer` builds no Cesium clock widgets. -->
    <clock-deck v-if="showUI" />
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
import ClockDeck from "./ClockDeck.vue";
import EntityInfoPanel from "./EntityInfoPanel.vue";
import GroundStationList from "./GroundStationList.vue";
import SatelliteBrowser from "./SatelliteBrowser.vue";
import SkyHud from "./SkyHud.vue";

type MenuKey = "cat" | "sat" | "gs" | "map" | "view" | "ios" | "render";

// Async, so the benchmark stays out of the main bundle.
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
});
const showUI = ref(true);

const cesiumStore = useCesiumStore();
const { layers, terrainProvider, surfaceModel, starMap, sceneMode, cameraMode, pixelRatio, msaa, showFps, showBenchmark, requestRenderMode } = storeToRefs(cesiumStore);

// Starts with the builtin map, and widens once per page when the probes answer.
const starMapOptions = ref<StarMapName[]>([BUILTIN_STAR_MAP]);
void availableStarMaps().then((names) => {
  starMapOptions.value = names;
});

const devicePixelRatio = window.devicePixelRatio;
const pixelRatioOptions = pixelRatiosFor(devicePixelRatio);

// The same function the globe reads, so the menu and the globe cannot disagree.
const effects = computed(() => surfaceEffects(surfaceModel.value, sceneMode.value));
const inert = computed(() => effects.value.inert);

const activeTerrain = computed(() => effects.value.terrain ?? terrainProvider.value);
const terrainImposed = computed(() => effects.value.terrain !== undefined);

// The imposed-terrain case names the user's choice, because the radio shows the terrain in force.
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

// `viewModeNote` derives the text from the rules; do not write the view modes out here.
const surfaceUnavailable = computed(() => {
  if (surfaceModel.value === "None" || !effects.value.unavailable.includes(surfaceModel.value as SurfaceModelName)) {
    return "";
  }
  return viewModeNote(surfaceModel.value);
});

// Write `layers` only through `setLayers`, which enforces at most one base layer.
// List order is z-order: the basemap goes first, overlays last.
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
const { enabledComponents } = storeToRefs(satStore);

const compassOffered = compassAvailable();
const { active: compassActive, pending: compassPending, toggle: toggleCompass } = useSkyCompass(cc);
const inSkyView = computed(() => sceneMode.value === SKY_MODE);

// iOS raises the permission prompt only from inside the click, so the box flips first and is corrected
// by hand: Vue re-syncs a checkbox only when its bound value changes, and a refusal leaves it unchanged.
async function onCompassToggle(event: Event): Promise<void> {
  await toggleCompass();
  (event.target as HTMLInputElement).checked = compassActive.value;
  // On success, close the panel so it does not cover the sky.
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
  // The controller hides the fullscreen button.
  cc.showUI = showUI.value;
}

function reload() {
  window.location.reload();
}
</script>
