<template>
  <div class="cesium">
    <div v-show="showUI" id="toolbarLeft" :class="{ 'toolbarLeft--panelOpen': anyMenuOpen }">
      <div ref="menuColumn" class="menuColumn panelSurface">
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
            :class="{ 'menuColumn__item--open': entryOpen(item.key) }"
            :aria-expanded="entryOpen(item.key)"
            :aria-label="item.label"
            :title="item.hint"
            @click="toggleMenu(item.key)"
          >
            <UIcon :name="item.icon" class="menuColumn__icon" />
            <span class="menuColumn__label">{{ item.label }}</span>
          </button>
          <about-dialog>
            <!-- A link, not a button: it is the only reference crawlers find to /about, and middle-click opens the page. -->
            <a
              class="menuColumn__item"
              href="/about"
              aria-label="About"
              title="What Satvis is, what it does, where its data comes from, and its credits"
              @click.prevent="closeMenus"
            >
              <UIcon name="lucide:info" class="menuColumn__icon" />
              <span class="menuColumn__label">About</span>
            </a>
          </about-dialog>
        </nav>
      </div>
      <!-- v-if: the cards' pictures load only when it opens. -->
      <toolbar-panel v-if="openMenu === 'bookmarks'" title="Bookmarks" wide @close="closePanel('bookmarks')">
        <bookmark-panel @opened="onBookmarkOpened" />
      </toolbar-panel>
      <!-- v-if, not v-show: the virtualized list measures its scroll element on mount,
           and a hidden mount measures 0. Search and expansion state survive remounts in useSatelliteBrowser. -->
      <toolbar-panel v-if="openMenu === 'cat'" title="Satellites" wide @close="closePanel('cat')">
        <satellite-browser @show-info="onShowInfo" @browse="openCatalog" />
      </toolbar-panel>
      <!-- The full catalog grows out of the Satellites panel and takes its place; inside #toolbarLeft so it stacks over the clock. -->
      <catalog-sheet v-if="catalogOpen" ref="catalogSheet" @back="closeCatalog(true)" @close="closeCatalog(false)" @expand="closeMenus" @show-info="onShowInfo" />
      <!-- "Components", not "elements": an element set is the GP data. -->
      <toolbar-panel v-show="openMenu === 'sat'" title="Components" @close="closePanel('sat')">
        <label v-for="componentName in SATELLITE_COMPONENTS" :key="componentName" class="toolbarSwitch">
          <input v-model="enabledComponents" type="checkbox" :value="componentName" />
          {{ componentName }}
        </label>
      </toolbar-panel>
      <toolbar-panel v-show="openMenu === 'gs'" title="Locations" class="toolbarPanel--locations" @close="closePanel('gs')">
        <ground-station-list />
      </toolbar-panel>
      <toolbar-panel v-show="openMenu === 'map'" title="Map" @close="closePanel('map')">
        <!-- Both groups bind by provider, not token, so a url layer with an opacity
             (`ArcGis_0.5`) still matches. An inert group is dimmed but stays live. -->
        <div class="toolbarTitle" :class="{ 'toolbarTitle--inert': inert.includes('layers') }">Basemap</div>
        <label v-for="name in baseLayers" :key="name" class="toolbarSwitch" :class="{ 'toolbarSwitch--inert': inert.includes('layers') }">
          <input type="radio" name="basemap" :value="name" :checked="baseLayer === name" @change="setBaseLayer(name)" />
          {{ name }}
        </label>
        <div class="toolbarTitle" :class="{ 'toolbarTitle--inert': inert.includes('layers') }">Overlays</div>
        <label v-for="name in overlayLayers" :key="name" class="toolbarSwitch" :class="{ 'toolbarSwitch--inert': inert.includes('layers') }">
          <input type="checkbox" :checked="hasOverlay(name)" @change="toggleOverlay(name, ($event.target as HTMLInputElement).checked)" />
          {{ name }}
        </label>
        <div v-if="inertReason('layers')" class="toolbarNote">{{ inertReason("layers") }}</div>
        <div class="toolbarTitle" :class="{ 'toolbarTitle--inert': inert.includes('terrain') }">Terrain</div>
        <!-- `:checked` shows the terrain in force, not the stored choice, which an
             imposing surface model overrides; disabled while imposed. -->
        <label v-for="name in terrainNames" :key="name" class="toolbarSwitch" :class="{ 'toolbarSwitch--inert': inert.includes('terrain') }">
          <input type="radio" name="terrain" :value="name" :checked="activeTerrain === name" :disabled="terrainImposed" @change="terrainProvider = name" />
          {{ name }}
        </label>
        <div v-if="inertReason('terrain')" class="toolbarNote">{{ inertReason("terrain") }}</div>
        <div class="toolbarTitle">Surface</div>
        <label v-for="name in SURFACE_MODELS" :key="name" class="toolbarSwitch">
          <input v-model="surfaceModel" type="radio" :value="name" />
          {{ name }}
        </label>
        <div v-if="surfaceUnavailable" class="toolbarNote">{{ surfaceUnavailable }}</div>
        <!-- Narrowed to the maps on the server (see src/config/starMaps.ts); `?stars=` still accepts every name. -->
        <div class="toolbarTitle">Star map</div>
        <label v-for="name in starMapOptions" :key="name" class="toolbarSwitch">
          <input v-model="starMap" type="radio" :value="name" />
          {{ name }}
        </label>
      </toolbar-panel>
      <!-- Two panels, one `scene` parameter (docs/adr/0003-sky-view.md): each view's settings stay visible, disabled where the other view is up. -->
      <toolbar-panel v-show="openMenu === 'globe'" title="Globe" @close="closePanel('globe')">
        <div class="toolbarTitle">Projection</div>
        <!-- No projection is checked in the sky view, as a checked one read as the active view;
             the Sky panel enters it, and a projection leaves it. -->
        <segmented-control :model-value="inSkyView ? undefined : sceneMode" label="Projection" :options="PROJECTION_OPTIONS" @update:model-value="sceneMode = $event!" />
        <div v-if="inSkyView" class="toolbarNote">In the sky view; a projection leaves it.</div>
        <div class="toolbarTitle">Camera</div>
        <segmented-control v-model="cameraMode" label="Camera" :options="CAMERA_OPTIONS" :disabled="inSkyView" />
        <div v-if="inSkyView" class="toolbarNote">The sky view holds the camera.</div>
      </toolbar-panel>
      <toolbar-panel v-show="openMenu === 'sky'" title="Sky" @close="closePanel('sky')">
        <!-- Each row enters the sky view standing there, or moves a view already up (docs/adr/0003-sky-view.md).
             Every row waits for a fix in flight, which would otherwise move the view after a later tap. -->
        <div class="toolbarTitle">Look up from</div>
        <button type="button" class="toolbarPlace" :aria-current="standingAtGeolocation ? 'location' : undefined" :disabled="locating" @click="lookUpFromHere">
          <!-- The spinner replaces the icon while the device's position comes back. -->
          <span v-if="locating" class="toolbarSpinner"></span>
          <UIcon v-else name="lucide:locate-fixed" class="toolbarPlace__icon" />
          <span class="toolbarPlace__label">My location</span>
        </button>
        <button
          v-for="place in skyPlaces"
          :key="place.index"
          type="button"
          class="toolbarPlace"
          :aria-current="inSkyView && observerStation === place.index ? 'location' : undefined"
          :disabled="locating"
          @click="lookUpFrom(place.index)"
        >
          <UIcon name="lucide:map-pin" class="toolbarPlace__icon" />
          <span class="toolbarPlace__label">{{ place.label }}</span>
        </button>
        <button v-if="inSkyView" type="button" class="toolbarPlace toolbarPlace--leave" :disabled="locating" @click="leaveSkyView">
          <UIcon name="lucide:globe" class="toolbarPlace__icon" />
          <span class="toolbarPlace__label">Back to the globe</span>
        </button>
        <div v-if="skyPlaces.length === 0" class="toolbarNote">Locations you add are listed here too.</div>
        <div v-if="compassOffered || !minimalUI" class="toolbarTitle">Aiming</div>
        <label v-if="compassOffered" class="toolbarSwitch">
          <input type="checkbox" :checked="compassActive" :disabled="compassPending || !inSkyView" @change="onCompassToggle" />
          <!-- The spinner replaces the mark while the sensor is probed. -->
          <span v-if="compassPending" class="toolbarSpinner"></span>
          Use compass
        </label>
        <!-- Hidden in minimalUI (iOS, iframe), where there is no keyboard. -->
        <div v-if="!minimalUI" class="toolbarNote">WASD walks the observer, Q and E change height.</div>
        <div class="toolbarTitle">Out of sight</div>
        <segmented-control v-model="unseen" label="Out of sight" :options="UNSEEN_OPTIONS" :disabled="!inSkyView" />
        <div class="toolbarNote">In Earth's shadow, too far away or during daylight.</div>
      </toolbar-panel>
      <toolbar-panel v-show="openMenu === 'render'" title="Graphics" @close="closePanel('render')">
        <div class="toolbarTitle">Measurement</div>
        <label class="toolbarSwitch">
          <input v-model="showFps" type="checkbox" />
          FPS
        </label>
        <label class="toolbarSwitch">
          <input v-model="showBenchmark" type="checkbox" />
          Benchmark
        </label>
        <!-- Under Measurement: with render-on-demand on, frame gaps measure idleness, not scene cost. -->
        <label class="toolbarSwitch">
          <input v-model="requestRenderMode" type="checkbox" />
          RequestRender
        </label>
        <div class="toolbarTitle">Scene effects</div>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.fog.enabled" type="checkbox" />
          Fog
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.enableLighting" type="checkbox" />
          Lighting
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.highDynamicRange" type="checkbox" />
          HDR
        </label>
        <label class="toolbarSwitch">
          <input v-model="cc.viewer.scene.globe.showGroundAtmosphere" type="checkbox" />
          Atmosphere
        </label>
        <!-- Ladders rather than switches; see src/config/rendering.ts. -->
        <div class="toolbarTitle">Pixel ratio</div>
        <label v-for="ratio in pixelRatioOptions" :key="ratio" class="toolbarSwitch">
          <input v-model="pixelRatio" type="radio" :value="ratio" />
          {{ ratio === "native" ? `${devicePixelRatio.toFixed(1)}x (Native)` : `${Number(ratio).toFixed(1)}x` }}
        </label>
        <div class="toolbarTitle">Antialiasing (MSAA)</div>
        <segmented-control v-model="msaa" label="Antialiasing (MSAA)" :options="MSAA_OPTIONS" />
      </toolbar-panel>
    </div>
    <!-- The native app's corner, in its order: the eye first, so it stays put as the others come and go. -->
    <div id="toolbarRight">
      <UTooltip :text="uiLabel">
        <button type="button" class="cesium-button cesium-toolbar-button" :aria-label="uiLabel" @click="toggleUI">
          <UIcon :name="showUI ? 'lucide:eye' : 'lucide:eye-off'" />
        </button>
      </UTooltip>
      <template v-if="showUI">
        <UTooltip :text="homeLabel">
          <button type="button" class="cesium-button cesium-toolbar-button" :aria-label="homeLabel" @click="goHome">
            <UIcon name="lucide:globe" />
          </button>
        </UTooltip>
        <UTooltip v-if="inSkyView && compassOffered" :text="compassLabel">
          <button
            type="button"
            class="cesium-button cesium-toolbar-button"
            :class="{ 'toolbarRight__button--on': compassActive }"
            :aria-label="compassLabel"
            :disabled="compassPending"
            @click="toggleCompassAim"
          >
            <UIcon name="lucide:compass" />
          </button>
        </UTooltip>
        <UTooltip v-if="tracking" text="Stop tracking">
          <button type="button" class="cesium-button cesium-toolbar-button" aria-label="Stop tracking" @click="cc.viewer.trackedEntity = undefined">
            <UIcon name="lucide:video-off" />
          </button>
        </UTooltip>
      </template>
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
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { useController } from "../composables/useController";
import { useGeolocation } from "../composables/useGeolocation";
import { useSelectedEntity } from "../composables/useSelectedEntity";
import { compassAvailable, useSkyCompass } from "../composables/useSkyCompass";
import { SATELLITE_COMPONENTS } from "../config/components";
import { PHONE_WIDTH } from "../config/layout";
import { MSAA_RATES, pixelRatiosFor } from "../config/rendering";
import { availableStarMaps, BUILTIN_STAR_MAP, type StarMapName } from "../config/starMaps";
import { type MapGroup, SURFACE_MODELS, type SurfaceModelName, surfaceEffects, viewModeNote } from "../config/surfaceModels";
import { CAMERA_MODES, SCENE_MODES, SKY_MODE } from "../config/viewModes";
import { baseLayerNames, overlayLayerNames, terrainProviderNames } from "../modules/CesiumLayerProviders";
import { stationLabel } from "../modules/GroundStationEntity";
import { DeviceDetect } from "../modules/util/DeviceDetect";
import { GEOLOCATION } from "../modules/util/groundStationEdits";
import { UNSEEN_MODES, type UnseenMode } from "../modules/util/visibility";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import AboutDialog from "./AboutDialog.vue";
import BookmarkPanel from "./BookmarkPanel.vue";
import CatalogSheet from "./catalog/CatalogSheet.vue";
import ClockDeck from "./ClockDeck.vue";
import EntityInfoPanel from "./EntityInfoPanel.vue";
import GroundStationList from "./GroundStationList.vue";
import SatelliteBrowser from "./SatelliteBrowser.vue";
import SegmentedControl from "./SegmentedControl.vue";
import SkyHud from "./SkyHud.vue";
import ToolbarPanel from "./ToolbarPanel.vue";

type MenuKey = "bookmarks" | "cat" | "sat" | "gs" | "map" | "globe" | "sky" | "render";

/** Async, so the benchmark stays out of the main bundle. */
const BenchmarkPanel = defineAsyncComponent(() => import("./BenchmarkPanel.vue"));

const cc = useController();

/** The one panel open, if any. */
const openMenu = ref<MenuKey>();
const anyMenuOpen = computed(() => openMenu.value !== undefined);
const showUI = ref(true);

const menuColumn = ref<HTMLElement>();
const menuToggle = ref<HTMLButtonElement>();
const entryButtons: Partial<Record<MenuKey, HTMLButtonElement | null>> = {};

/** A known phone width, below which the column stacks over the info panel. A hidden tab can report 0. */
const isNarrow = (): boolean => window.innerWidth > 0 && window.innerWidth < PHONE_WIDTH;

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
const { baseLayer, terrainProvider, surfaceModel, starMap, sceneMode, unseen, cameraMode, pixelRatio, msaa, showFps, showBenchmark, requestRenderMode } = storeToRefs(cesiumStore);

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

const baseLayers = baseLayerNames();
const overlayLayers = overlayLayerNames();
const terrainNames = terrainProviderNames();

const { hasOverlay, setBaseLayer, toggleOverlay } = cesiumStore;

const satStore = useSatStore();
const { enabledComponents, groundStations, observerStation } = storeToRefs(satStore);

const compassOffered = compassAvailable();
const minimalUI = DeviceDetect.minimalUI();
const { active: compassActive, pending: compassPending, toggle: toggleCompass } = useSkyCompass(cc);
const inSkyView = computed(() => sceneMode.value === SKY_MODE);

const UNSEEN_LABEL: Record<UnseenMode, string> = { show: "Show", dim: "Dim", hide: "Hide" };
const UNSEEN_OPTIONS = UNSEEN_MODES.map((mode) => ({ value: mode, label: UNSEEN_LABEL[mode] }));
const PROJECTION_OPTIONS = SCENE_MODES.filter((mode) => mode !== SKY_MODE).map((mode) => ({ value: mode, label: mode }));
const CAMERA_OPTIONS = CAMERA_MODES.map((mode) => ({ value: mode, label: mode }));
const MSAA_OPTIONS = MSAA_RATES.map((rate) => ({ value: rate, label: rate === "off" ? "Off" : `${rate}x` }));

/** The projection Back to the globe returns to. Not in the url, which holds only the view mode. */
const returnProjection = ref(inSkyView.value ? "3D" : sceneMode.value);
watch(sceneMode, (mode) => {
  if (mode !== SKY_MODE) {
    returnProjection.value = mode;
  }
});

const { pending: locating, locate } = useGeolocation();

/** Every station but Geolocation, which My location stands for, by its index in the list. */
const skyPlaces = computed(() =>
  groundStations.value.flatMap((station, index) => (station.name === GEOLOCATION ? [] : [{ index, label: stationLabel(station.name, station.lat, station.lon) }])),
);
const standingAtGeolocation = computed(() => inSkyView.value && groundStations.value[observerStation.value]?.name === GEOLOCATION);

/** Stands where the device is, which may give no position, and then nothing opens. */
async function lookUpFromHere(): Promise<void> {
  if (await locate({ observe: true })) {
    sceneMode.value = SKY_MODE;
  }
}

/** Designates the station, without reordering the list; a view already up moves there. */
function lookUpFrom(index: number): void {
  satStore.setObserverStation(index);
  sceneMode.value = SKY_MODE;
}

/** Returns to the projection the sky view was entered from. */
function leaveSkyView(): void {
  sceneMode.value = returnProjection.value;
}

/** The Sky panel's switch and the corner's button. Once aiming, the panel closes so it does not cover the sky. */
async function toggleCompassAim(): Promise<void> {
  await toggleCompass();
  if (compassActive.value && openMenu.value === "sky") {
    openMenu.value = undefined;
  }
}

/**
 * iOS raises the permission prompt only from inside the click, so the box flips first and is corrected
 * by hand: Vue re-syncs a checkbox only when its bound value changes, and a refusal leaves it unchanged.
 */
async function onCompassToggle(event: Event): Promise<void> {
  await toggleCompassAim();
  (event.target as HTMLInputElement).checked = compassActive.value;
}

/** The corner's names, the native app's, for its tooltips and screen readers alike. */
const uiLabel = computed(() => (showUI.value ? "Hide UI" : "Show UI"));
const homeLabel = computed(() => (inSkyView.value ? "Leave the sky view" : "Home view"));
const compassLabel = computed(() => (compassActive.value ? "Stop aiming by compass" : "Aim by compass"));

/** The corner's globe: out of the sky view, else home, letting go of what is followed, as the native app's. */
function goHome(): void {
  if (inSkyView.value) {
    leaveSkyView();
  } else {
    cc.flyHome();
  }
}

/** Whether the camera follows a satellite or a station. Cesium's, so it is mirrored here. */
const tracking = ref(cc.viewer.trackedEntity !== undefined);

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

const removeTrackedListener = cc.viewer.trackedEntityChanged.addEventListener(() => {
  tracking.value = cc.viewer.trackedEntity !== undefined;
});

onBeforeUnmount(() => {
  windowListeners.abort();
  removeTrackedListener();
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

/** Clears the way to the scene a bookmark opened, as a tap on the globe does. */
function onBookmarkOpened(): void {
  closeMenus();
  if (isNarrow()) {
    menuExpanded.value = false;
  }
}

/** A cancelled press is no tap. */
function onPointerCancel(): void {
  globePress = undefined;
}

/** A panel opens over the catalog sheet, which stays open; the Satellites entry takes the sheet back to the panel it grew from. */
function toggleMenu(name: MenuKey) {
  if (name === "cat") {
    catalogOpen.value = false;
  }
  openMenu.value = openMenu.value === name ? undefined : name;
}

function closeMenus() {
  openMenu.value = undefined;
}

const { selection } = useSelectedEntity(cc);

/** Whether two boxes share any area. */
const overlaps = (a: DOMRect, b: DOMRect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Closes the open panel, and folds the column, where either would cover the info panel: measured, not by width. */
async function uncoverInfoPanel(): Promise<void> {
  await nextTick();
  const info = document.querySelector(".entity-info-panel")?.getBoundingClientRect();
  if (!info) {
    return;
  }
  const covers = (element: Element | undefined) => !!element && overlaps(element.getBoundingClientRect(), info);
  if ([...document.querySelectorAll("#toolbarLeft > .toolbarPanel")].some(covers)) {
    closeMenus();
  }
  if (covers(menuColumn.value)) {
    menuExpanded.value = false;
  }
}

/**
 * Shown again, if it is already selected and a panel opened over it since. The catalog sheet stays open
 * beside it, but on a phone, where it covers it at any height.
 */
function onShowInfo(): void {
  if (isNarrow()) {
    catalogOpen.value = false;
  }
  void uncoverInfoPanel();
  // A satellite not built yet is selected a frame or more after the click; one already selected never
  // changes the selection, so the watch gives up.
  const stop = watch(selection, () => {
    stop();
    void uncoverInfoPanel();
  });
  setTimeout(stop, 2000);
}

/** The catalog sheet, opened from the Satellites panel, which it replaces while open. */
const catalogOpen = ref(false);
/** A menu entry's panel is open; the Satellites entry's too while the sheet grown from it is. */
const entryOpen = (key: MenuKey) => openMenu.value === key || (key === "cat" && catalogOpen.value);
const catalogSheet = ref<InstanceType<typeof CatalogSheet> | null>(null);

/** On a phone the column would cover the sheet's header, so it folds. */
function openCatalog(): void {
  closeMenus();
  if (isNarrow()) {
    menuExpanded.value = false;
  }
  catalogOpen.value = true;
}

/** `back` returns to the Satellites panel; otherwise everything closes. */
function closeCatalog(back: boolean): void {
  catalogOpen.value = false;
  if (back) {
    openMenu.value = "cat";
  }
}

function toggleMenuColumn() {
  menuExpanded.value = !menuExpanded.value;
  if (!menuExpanded.value) {
    closeMenus();
  }
}

/** Closes the open panel, which lies over the catalog sheet, else the sheet's innermost layer, then the column. Inputs, an open dialog and an open menu keep Escape for themselves. */
function onEscape(event: KeyboardEvent) {
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    (event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]") ||
    // Not every [role=dialog]: Cesium's credit lightbox carries the role while hidden.
    document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')
  ) {
    return;
  }
  if (openMenu.value) {
    closePanel(openMenu.value);
  } else if (catalogOpen.value) {
    catalogSheet.value?.escape();
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
  openMenu.value = undefined;
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
