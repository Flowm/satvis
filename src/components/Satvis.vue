<template>
  <div class="cesium">
    <div v-show="showUI" id="toolbarLeft" :class="{ 'toolbarLeft--panelOpen': anyMenuOpen }">
      <div class="menuColumn">
        <button
          ref="menuToggle"
          type="button"
          class="menuColumn__toggle"
          :aria-expanded="menuExpanded"
          aria-controls="menuColumnList"
          :aria-label="menuExpanded ? 'Close menu' : 'Open menu'"
          @click="toggleMenuColumn"
        >
          <UIcon :name="menuExpanded ? 'lucide:chevron-up' : 'lucide:menu'" class="menuColumn__toggleIcon" />
          <span class="menuColumn__label menuColumn__label--muted">Menu</span>
        </button>
        <nav v-show="menuExpanded" id="menuColumnList" class="menuColumn__list" aria-label="Main menu">
          <button
            v-for="item in menuItems"
            :key="item.key"
            :ref="(el) => (entryButtons[item.key] = el as HTMLButtonElement | null)"
            type="button"
            class="menuColumn__item"
            :class="{ 'menuColumn__item--open': menu[item.key] }"
            :aria-expanded="menu[item.key]"
            :aria-label="item.label"
            :title="item.hint"
            @click="toggleMenu(item.key)"
          >
            <UIcon :name="item.icon" class="menuColumn__icon" />
            <span class="menuColumn__label">{{ item.label }}</span>
          </button>
        </nav>
      </div>
      <!-- v-if, not v-show: the virtualized list measures its scroll element on mount,
           and a hidden mount measures 0. Search and expansion state survive remounts in useSatelliteBrowser. -->
      <toolbar-panel v-if="menu.cat" title="Satellites" wide class="toolbarSwitches--catalog" @close="closePanel('cat')">
        <satellite-browser @show-info="onShowInfo" />
      </toolbar-panel>
      <!-- "Components", not "elements": an element set is the GP data. -->
      <toolbar-panel v-show="menu.sat" title="Components" @close="closePanel('sat')">
        <label v-for="componentName in cc.sats.availableComponents" :key="componentName" class="toolbarSwitch">
          <input v-model="enabledComponents" type="checkbox" :value="componentName" />
          <span class="slider"></span>
          {{ componentName }}
        </label>
      </toolbar-panel>
      <toolbar-panel v-show="menu.gs" title="Ground station" @close="closePanel('gs')">
        <ground-station-list />
      </toolbar-panel>
      <toolbar-panel v-show="menu.map" title="Map" @close="closePanel('map')">
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
      </toolbar-panel>
      <toolbar-panel v-show="menu.view" title="View" @close="closePanel('view')">
        <div class="toolbarTitle">View mode</div>
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
      </toolbar-panel>
      <toolbar-panel v-show="menu.render" title="Graphics" @close="closePanel('render')">
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
      </toolbar-panel>
    </div>
    <div id="toolbarRight">
      <about-dialog v-if="showUI" />
      <UTooltip :text="showUI ? 'Hide UI' : 'Show UI'">
        <button type="button" class="cesium-button cesium-toolbar-button" :aria-label="showUI ? 'Hide UI' : 'Show UI'" @click="toggleUI">
          <UIcon :name="showUI ? 'lucide:eye' : 'lucide:eye-off'" />
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
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref } from "vue";

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
import ToolbarPanel from "./ToolbarPanel.vue";

type MenuKey = "cat" | "sat" | "gs" | "map" | "view" | "render";

/** Async, so the benchmark stays out of the main bundle. */
const BenchmarkPanel = defineAsyncComponent(() => import("./BenchmarkPanel.vue"));

const cc = useController();

const menu = reactive<Record<MenuKey, boolean>>({
  cat: false,
  sat: false,
  gs: false,
  map: false,
  view: false,
  render: false,
});
const anyMenuOpen = computed(() => Object.values(menu).some(Boolean));
const showUI = ref(true);

const menuToggle = ref<HTMLButtonElement>();
const entryButtons: Partial<Record<MenuKey, HTMLButtonElement | null>> = {};

/** A known phone width, below which the column stacks over the info panel. A hidden tab can report 0. */
const isNarrow = (): boolean => window.innerWidth > 0 && window.innerWidth < 640;

const menuExpanded = ref(!isNarrow());

/** `hint` is the hover text, saying what is behind an entry. */
const menuItems: { key: MenuKey; label: string; icon: string; hint: string }[] = [
  { key: "cat", label: "Satellites", icon: "lucide:orbit", hint: "Search and pick which satellites to show" },
  { key: "sat", label: "Components", icon: "lucide:satellite", hint: "Orbits, ground tracks, labels and sensor cones" },
  { key: "gs", label: "Ground station", icon: "lucide:map-pin", hint: "Your location, for pass predictions" },
  { key: "map", label: "Map", icon: "lucide:layers", hint: "Basemap, overlays, terrain and stars" },
  { key: "view", label: "View", icon: "lucide:telescope", hint: "Globe, flat map or sky view, and the camera" },
  { key: "render", label: "Graphics", icon: "lucide:gauge", hint: "Quality, effects and performance" },
];

const cesiumStore = useCesiumStore();
const { layers, terrainProvider, surfaceModel, starMap, sceneMode, cameraMode, pixelRatio, msaa, showFps, showBenchmark, requestRenderMode } = storeToRefs(cesiumStore);

/** Starts with the builtin map, and widens once per page when the probes answer. */
const starMapOptions = ref<StarMapName[]>([BUILTIN_STAR_MAP]);
void availableStarMaps().then((names) => {
  starMapOptions.value = names;
});

const devicePixelRatio = window.devicePixelRatio;
const pixelRatioOptions = pixelRatiosFor(devicePixelRatio);

/** The same function the globe reads, so the menu and the globe cannot disagree. */
const effects = computed(() => surfaceEffects(surfaceModel.value, sceneMode.value));
const inert = computed(() => effects.value.inert);

const activeTerrain = computed(() => effects.value.terrain ?? terrainProvider.value);
const terrainImposed = computed(() => effects.value.terrain !== undefined);

/**
 * The imposed-terrain case names the user's choice, because the radio shows the terrain in force.
 */
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

/** `viewModeNote` derives the text from the rules; do not write the view modes out here. */
const surfaceUnavailable = computed(() => {
  if (surfaceModel.value === "None" || !effects.value.unavailable.includes(surfaceModel.value as SurfaceModelName)) {
    return "";
  }
  return viewModeNote(surfaceModel.value);
});

/**
 * Write `layers` only through `setLayers`, which enforces at most one base layer.
 * List order is z-order: the basemap goes first, overlays last.
 */
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

/**
 * iOS raises the permission prompt only from inside the click, so the box flips first and is corrected
 * by hand: Vue re-syncs a checkbox only when its bound value changes, and a refusal leaves it unchanged.
 */
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
  window.addEventListener("keydown", onEscape);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onEscape);
});

function toggleMenu(name: MenuKey) {
  const oldState = menu[name];
  closeMenus();
  menu[name] = !oldState;
}

function closeMenus() {
  (Object.keys(menu) as MenuKey[]).forEach((k) => {
    menu[k] = false;
  });
}

/** On a phone the catalog and the column would cover the info panel just opened. */
function onShowInfo(): void {
  if (isNarrow()) {
    closeMenus();
    menuExpanded.value = false;
  }
}

function toggleMenuColumn() {
  menuExpanded.value = !menuExpanded.value;
  if (!menuExpanded.value) {
    closeMenus();
  }
}

/** Closes the open panel, then the column. Inputs and an open dialog keep Escape for themselves. */
function onEscape(event: KeyboardEvent) {
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    (event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]") ||
    // Not every [role=dialog]: Cesium's credit lightbox carries the role while hidden.
    document.querySelector('[role="dialog"][data-state="open"]')
  ) {
    return;
  }
  const open = (Object.keys(menu) as MenuKey[]).find((k) => menu[k]);
  if (open) {
    closePanel(open);
  } else {
    const focusInList = !!document.activeElement?.closest(".menuColumn__list");
    menuExpanded.value = false;
    if (focusInList) {
      menuToggle.value?.focus();
    }
  }
}

/** Focus inside the closing panel moves to its entry, so keyboard users keep their place. */
function closePanel(key: MenuKey) {
  const focusInPanel = !!document.activeElement?.closest(".toolbarPanel");
  menu[key] = false;
  if (focusInPanel) {
    entryButtons[key]?.focus();
  }
}

function toggleUI() {
  showUI.value = !showUI.value;
  // cc owns the Cesium fullscreen button, which showUI also hides.
  cc.showUI = showUI.value;
}
</script>
