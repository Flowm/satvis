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
      <!-- v-if: the cards' pictures load only when it opens. -->
      <toolbar-panel v-if="menu.bookmarks" title="Bookmarks" wide @close="closePanel('bookmarks')">
        <bookmark-panel />
      </toolbar-panel>
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
      <toolbar-panel v-show="menu.gs" title="Locations" @close="closePanel('gs')">
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
      <!-- Two panels, one `scene` parameter (docs/adr/0003-sky-view.md): each view's settings stay visible, disabled where the other view is up. -->
      <toolbar-panel v-show="menu.globe" title="Globe" @close="closePanel('globe')">
        <div class="toolbarTitle">Projection</div>
        <!-- None is checked in the sky view: a checked projection read as the active one. -->
        <label v-for="name in projections" :key="name" class="toolbarSwitch">
          <input type="radio" name="projection" :checked="!inSkyView && sceneMode === name" @change="sceneMode = name" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div v-if="inSkyView" class="toolbarNote">In the sky view. Pick one to return to the globe.</div>
        <div class="toolbarTitle">Camera</div>
        <label v-for="name in cc.cameraModes" :key="name" class="toolbarSwitch">
          <input v-model="cameraMode" type="radio" :value="name" :disabled="inSkyView" />
          <span class="slider"></span>
          {{ name }}
        </label>
        <div v-if="inSkyView" class="toolbarNote">The sky view holds the camera.</div>
      </toolbar-panel>
      <toolbar-panel v-show="menu.sky" title="Sky" @close="closePanel('sky')">
        <div class="toolbarTitle">Sky view</div>
        <label class="toolbarSwitch">
          <input type="checkbox" :checked="inSkyView" :disabled="locating" @change="onSkyToggle" />
          <!-- The spinner replaces the slider while the device's position comes back. -->
          <span v-if="locating" class="toolbarSpinner"></span>
          <span v-else class="slider"></span>
          Look up
        </label>
        <div class="toolbarNote">Start sky view from your current location. To look up elsewhere, use a location pin’s sky view button.</div>
        <div v-if="compassOffered || !cc.minimalUI" class="toolbarTitle">Aiming</div>
        <label v-if="compassOffered" class="toolbarSwitch">
          <input type="checkbox" :checked="compassActive" :disabled="compassPending || !inSkyView" @change="onCompassToggle" />
          <!-- The spinner replaces the slider: both occupy the row's left gutter. -->
          <span v-if="compassPending" class="toolbarSpinner"></span>
          <span v-else class="slider"></span>
          Use compass
        </label>
        <!-- Hidden in minimalUI (iOS, iframe), where there is no keyboard. -->
        <div v-if="!cc.minimalUI" class="toolbarNote">WASD walks the observer, Q and E change height.</div>
        <div class="toolbarTitle">Out of sight</div>
        <label v-for="mode in UNSEEN_MODES" :key="mode" class="toolbarSwitch">
          <input v-model="unseen" type="radio" :value="mode" :disabled="!inSkyView" />
          <span class="slider"></span>
          {{ UNSEEN_LABEL[mode] }}
        </label>
        <div class="toolbarNote">In Earth's shadow, too far away or during daylight.</div>
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
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import { useController } from "../composables/useController";
import { useGeolocation } from "../composables/useGeolocation";
import { compassAvailable, useSkyCompass } from "../composables/useSkyCompass";
import { layerProvider } from "../config/layers";
import { MSAA_RATES, pixelRatiosFor } from "../config/rendering";
import { availableStarMaps, BUILTIN_STAR_MAP, type StarMapName } from "../config/starMaps";
import { type MapGroup, SURFACE_MODELS, type SurfaceModelName, surfaceEffects, viewModeNote } from "../config/surfaceModels";
import { SKY_MODE } from "../config/viewModes";
import { DeviceDetect } from "../modules/util/DeviceDetect";
import { UNSEEN_MODES, type UnseenMode } from "../modules/util/visibility";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import AboutDialog from "./AboutDialog.vue";
import BookmarkPanel from "./BookmarkPanel.vue";
import ClockDeck from "./ClockDeck.vue";
import EntityInfoPanel from "./EntityInfoPanel.vue";
import GroundStationList from "./GroundStationList.vue";
import SatelliteBrowser from "./SatelliteBrowser.vue";
import SkyHud from "./SkyHud.vue";
import ToolbarPanel from "./ToolbarPanel.vue";

type MenuKey = "bookmarks" | "cat" | "sat" | "gs" | "map" | "globe" | "sky" | "render";

/** Async, so the benchmark stays out of the main bundle. */
const BenchmarkPanel = defineAsyncComponent(() => import("./BenchmarkPanel.vue"));

const cc = useController();

const menu = reactive<Record<MenuKey, boolean>>({
  bookmarks: false,
  cat: false,
  sat: false,
  gs: false,
  map: false,
  globe: false,
  sky: false,
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
  { key: "bookmarks", label: "Bookmarks", icon: "lucide:bookmark", hint: "Demos, saved views and links you opened, and the way back to the default view" },
  { key: "cat", label: "Satellites", icon: "lucide:orbit", hint: "Search and pick which satellites to show" },
  { key: "sat", label: "Components", icon: "lucide:satellite", hint: "Orbits, ground tracks, labels and sensor cones" },
  { key: "map", label: "Map", icon: "lucide:layers", hint: "Basemap, overlays, terrain and stars" },
  { key: "gs", label: "Locations", icon: "lucide:map-pin", hint: "Ground stations, for pass predictions and the sky view" },
  { key: "globe", label: "Globe", icon: "lucide:globe", hint: "Globe, flat map or Columbus view, and the camera" },
  { key: "sky", label: "Sky", icon: "lucide:telescope", hint: "Look up from a ground station and see what passes over" },
  { key: "render", label: "Graphics", icon: "lucide:gauge", hint: "Quality, effects and performance" },
];

const cesiumStore = useCesiumStore();
const { layers, terrainProvider, surfaceModel, starMap, sceneMode, unseen, cameraMode, pixelRatio, msaa, showFps, showBenchmark, requestRenderMode } = storeToRefs(cesiumStore);

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

const UNSEEN_LABEL: Record<UnseenMode, string> = { show: "Show", dim: "Dim", hide: "Hide" };
const projections = cc.sceneModes.filter((mode) => mode !== SKY_MODE);

/** The projection the Sky switch returns to. Not in the url, which holds only the view mode. */
const returnProjection = ref(inSkyView.value ? "3D" : sceneMode.value);
watch(sceneMode, (mode) => {
  if (mode !== SKY_MODE) {
    returnProjection.value = mode;
  }
});

const { pending: locating, locate } = useGeolocation(cc);

/**
 * Look up stands where the device is; only a location's panel stands somewhere else.
 * The box follows the store, not the click: the device may give no position.
 */
async function onSkyToggle(event: Event): Promise<void> {
  const box = event.target as HTMLInputElement;
  const on = box.checked;
  box.checked = inSkyView.value;
  if (!on) {
    sceneMode.value = returnProjection.value;
  } else if (await locate({ observe: true })) {
    sceneMode.value = SKY_MODE;
  }
}

/**
 * iOS raises the permission prompt only from inside the click, so the box flips first and is corrected
 * by hand: Vue re-syncs a checkbox only when its bound value changes, and a refusal leaves it unchanged.
 */
async function onCompassToggle(event: Event): Promise<void> {
  await toggleCompass();
  (event.target as HTMLInputElement).checked = compassActive.value;
  // On success, close the panel so it does not cover the sky.
  if (compassActive.value) {
    menu.sky = false;
  }
}

/** Aborted on unmount, removing the window listeners. */
const windowListeners = new AbortController();

onMounted(() => {
  showUI.value = !DeviceDetect.inIframe();
  const { signal } = windowListeners;
  window.addEventListener("keydown", onEscape, { signal });
  // Capture, so the menu marks its tap before the Viewer's own pointerup handler picks.
  window.addEventListener("pointerdown", onPointerDown, { capture: true, signal });
  window.addEventListener("pointerup", onPointerUp, { capture: true, signal });
  window.addEventListener("pointercancel", onPointerCancel, { capture: true, signal });
});

onBeforeUnmount(() => {
  windowListeners.abort();
});

/** Pixels a press on the globe may travel and still count as a tap rather than a drag. */
const TAP_SLOP_PX = 8;

/** The press on the globe that may close the menu on release. */
let globePress: { id: number; x: number; y: number } | undefined;

/** The main button on the globe only. A second finger is a pinch, so it drops the pending press. */
function onPointerDown(event: PointerEvent): void {
  const onGlobe = event.target === cc.viewer.scene.canvas && event.button === 0;
  globePress = event.isPrimary && onGlobe ? { id: event.pointerId, x: event.clientX, y: event.clientY } : undefined;
}

/**
 * A tap on the globe returns the menu to how it starts: no panel, and on a phone a folded column. The tap
 * still selects what it hits, but a miss keeps the selection. Pick mode leaves the menu open, so the new
 * station shows in its panel.
 */
function onPointerUp(event: PointerEvent): void {
  const press = globePress;
  globePress = undefined;
  if (!press || press.id !== event.pointerId || Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP_PX || cesiumStore.pickMode) {
    return;
  }
  const foldColumn = isNarrow() && menuExpanded.value;
  if (!anyMenuOpen.value && !foldColumn) {
    return;
  }
  closeMenus();
  if (foldColumn) {
    menuExpanded.value = false;
  }
  cc.keepSelectionOnEmptyClick();
}

/** A cancelled press is no tap. */
function onPointerCancel(): void {
  globePress = undefined;
}

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
