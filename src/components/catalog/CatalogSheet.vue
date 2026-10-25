<!-- The catalog sheet (ADR 0012): one layout at two sizes, a bottom sheet and full screen. -->
<template>
  <section
    ref="sheetEl"
    class="catalogSheet"
    :class="{ 'catalogSheet--full': full, 'catalogSheet--dragging': dragHeight !== null }"
    :style="dragHeight === null ? undefined : { height: `${dragHeight}px` }"
    aria-label="Satellite catalog"
  >
    <header class="catalogSheet__head" @pointerdown="dragStart" @dblclick="onHeadDoubleClick">
      <button
        type="button"
        class="catalogSheet__grip"
        :aria-label="full ? 'Shrink to a sheet' : 'Expand to full screen'"
        :title="full ? 'Shrink (or drag down)' : 'Expand (or drag up; drag down to close)'"
        @click="onGripClick"
      />
      <span class="catalogSheet__title">Catalog</span>
      <span class="catalogSheet__count cs-num" aria-live="polite">{{ sheet.matched.value.length.toLocaleString() }}</span>
      <span class="catalogSheet__of cs-dim cs-num">of {{ sheet.rows.value.length.toLocaleString() }}<template v-if="sheet.isLoading.value"> · loading…</template></span>
      <span class="catalogSheet__chips" :class="{ 'catalogSheet__chips--empty': sheet.chips.value.length === 0 }">
        <span v-for="chip in sheet.chips.value" :key="chip.id" class="cs-chip">
          <b v-if="chip.facet">{{ chip.facet }}</b> {{ chip.value }}
          <button type="button" :aria-label="`Remove the filter ${chip.facet} ${chip.value}`" @click="sheet.removeChip(chip)"><UIcon name="lucide:x" /></button>
        </span>
      </span>
      <div class="catalogSheet__headActions">
        <button v-if="sheet.chips.value.length" type="button" class="cs-btn" @click="sheet.clearFilters()">
          <UIcon name="lucide:filter-x" /> <span class="catalogSheet__wide">Reset all</span>
        </button>
        <button type="button" class="cs-btn" aria-label="Add a custom satellite" title="Add a satellite from its TLE or OMM" @click="customOpen = true">
          <UIcon name="lucide:satellite" /> <span class="catalogSheet__wide">Add custom</span>
        </button>
        <button type="button" class="cs-iconBtn" :aria-label="full ? 'Shrink to a sheet' : 'Expand to full screen'" @click="full = !full">
          <UIcon :name="full ? 'lucide:chevrons-down' : 'lucide:chevrons-up'" />
        </button>
        <button type="button" class="cs-iconBtn" aria-label="Back to the Satellites panel" title="Back to the Satellites panel" @click="emit('back')">
          <UIcon name="lucide:minimize-2" />
        </button>
        <button type="button" class="cs-iconBtn" aria-label="Close the catalog" @click="emit('close')"><UIcon name="lucide:x" /></button>
      </div>
    </header>

    <!-- Phones only: the charts and the list take turns. -->
    <div class="catalogSheet__tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="pane === 'charts'" :class="{ on: pane === 'charts' }" @click="pane = 'charts'">
        <UIcon name="lucide:sliders-horizontal" /> Filters <span v-if="sheet.chips.value.length" class="catalogSheet__badge">{{ sheet.chips.value.length }}</span>
      </button>
      <button type="button" role="tab" :aria-selected="pane === 'list'" :class="{ on: pane === 'list' }" @click="pane = 'list'">
        <UIcon name="lucide:list" /> Satellites <span class="catalogSheet__badge cs-num">{{ sheet.matched.value.length.toLocaleString() }}</span>
      </button>
    </div>

    <div class="catalogSheet__body" :class="`catalogSheet__body--${pane}`">
      <div ref="chartsEl" class="catalogSheet__chartsWrap">
        <div class="catalogSheet__charts cs-scroll">
          <!-- An opened tile spans the full width at twice its height, capped; the rest flow around it. -->
          <div class="catalogSheet__heroes">
            <div :ref="tileRef('launch')" class="catalogSheet__tile" :class="{ 'catalogSheet__tile--open': opened === 'launch' }" :style="openStyle('launch')">
              <catalog-launch-histogram
                v-model:range="sheet.launchYears.value"
                v-model:scale="sheet.launchScale.value"
                :launches="sheet.result.value.launches"
                :height="opened === 'launch' ? openHeight - 86 : heroHeight"
                :open="opened === 'launch'"
                @toggle-open="toggleOpen('launch')"
              />
            </div>
            <div :ref="tileRef('shape')" class="catalogSheet__tile" :class="{ 'catalogSheet__tile--open': opened === 'shape' }" :style="openStyle('shape')">
              <catalog-shape-plot
                v-model:box="sheet.shape.value"
                :rows="sheet.rows.value"
                :bright-rows="sheet.result.value.shapeRows"
                :height="opened === 'shape' ? openHeight - 80 : heroHeight + 18"
                :open="opened === 'shape'"
                @toggle-open="toggleOpen('shape')"
              />
            </div>
            <!-- Shorter bars than the launches' by its legend and band labels, so the row's tiles stay level. -->
            <div :ref="tileRef('crossing')" class="catalogSheet__tile" :class="{ 'catalogSheet__tile--open': opened === 'crossing' }" :style="openStyle('crossing')">
              <catalog-crossing-histogram
                v-model:range="sheet.crossingHours.value"
                v-model:direction="sheet.crossingDirection.value"
                v-model:scale="sheet.crossingScale.value"
                :crossings="sheet.result.value.crossings"
                :height="opened === 'crossing' ? openHeight - 119 : heroHeight - 15"
                :open="opened === 'crossing'"
                @toggle-open="toggleOpen('crossing')"
              />
            </div>
            <div :ref="tileRef('apsides')" class="catalogSheet__tile" :class="{ 'catalogSheet__tile--open': opened === 'apsides' }" :style="openStyle('apsides')">
              <catalog-apsis-plot
                v-model:box="sheet.apsides.value"
                :rows="sheet.rows.value"
                :bright-rows="sheet.result.value.apsisRows"
                :height="opened === 'apsides' ? openHeight - 80 : heroHeight + 18"
                :open="opened === 'apsides'"
                @toggle-open="toggleOpen('apsides')"
              />
            </div>
          </div>
          <div class="catalogSheet__facets">
            <div
              v-for="tree in TREES"
              :key="tree.def.key"
              :ref="tileRef(tree.def.key)"
              class="catalogSheet__tile"
              :class="{ 'catalogSheet__tile--open': opened === tree.def.key }"
              :style="openStyle(tree.def.key)"
            >
              <catalog-facet-tree
                :def="tree.def"
                :branches="branchesOf(tree.def)"
                :picked="sheet.pickedFacets[tree.def.key]"
                :open="opened === tree.def.key"
                :top="tree.top"
                :unfolded-at-first="tree.unfolded"
                :hint-of="tree.hintOf"
                :color-of="tree.colorOf"
                :note="tree.note?.()"
                @toggle="sheet.toggle(tree.def.key, $event)"
                @toggle-parent="sheet.toggleParent(tree.def.key, $event)"
                @clear="sheet.clearFacet(tree.def.key)"
                @toggle-open="toggleOpen(tree.def.key)"
              />
            </div>
            <div
              v-for="def in FLAT_FACETS"
              :key="def.key"
              :ref="tileRef(def.key)"
              class="catalogSheet__tile"
              :class="{ 'catalogSheet__tile--open': opened === def.key }"
              :style="openStyle(def.key)"
            >
              <catalog-facet-detail
                v-if="opened === def.key"
                :def="def"
                :items="itemsOf(def)"
                :picked="sheet.pickedFacets[def.key]"
                @toggle="sheet.toggle(def.key, $event)"
                @pick-many="sheet.toggleAll(def.key, $event)"
                @clear="sheet.clearFacet(def.key)"
                @toggle-open="close"
              />
              <catalog-facet-tile
                v-else
                :def="def"
                :items="itemsOf(def)"
                :picked="sheet.pickedFacets[def.key]"
                :top="full ? 10 : 8"
                @toggle="sheet.toggle(def.key, $event)"
                @clear="sheet.clearFacet(def.key)"
                @toggle-open="open(def.key)"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="catalogSheet__list">
        <div class="catalogSheet__listHead">
          <div class="cs-search">
            <UIcon name="lucide:search" class="cs-mute" />
            <input v-model="sheet.query.value" placeholder="Name or NORAD id" aria-label="Find a satellite by name or NORAD id" />
            <button v-if="sheet.query.value" type="button" class="cs-iconBtn" aria-label="Clear the search" @click="sheet.query.value = ''"><UIcon name="lucide:x" /></button>
          </div>
          <div class="catalogSheet__actions">
            <span class="cs-dim cs-num">{{ sheet.matched.value.length.toLocaleString() }}<span class="catalogSheet__matchWord"> matches</span></span>
            <span class="catalogSheet__spacer" />
            <button type="button" class="cs-btn cs-btn--primary" :disabled="!sheet.matched.value.length" @click="show"><UIcon name="lucide:eye" /> Show only these</button>
            <button type="button" class="cs-btn" :disabled="!sheet.matched.value.length" title="Add the matches to what the globe shows" @click="add">
              <UIcon name="lucide:plus" />
            </button>
            <button type="button" class="cs-btn" :disabled="!anyShown" title="Hide the matches" @click="sheet.hide(sheet.matched.value)"><UIcon name="lucide:eye-off" /></button>
          </div>
          <p v-if="sheet.matched.value.length > SHOW_CAP" class="catalogSheet__cap cs-mute">
            Showing puts the first {{ SHOW_CAP }} on the globe. Narrow the filters to show them all.
          </p>
        </div>
        <catalog-list
          class="catalogSheet__rows"
          :rows="sheet.matched.value"
          :active="sheet.active.value"
          :sort-key="sheet.sortKey.value"
          :sort-descending="sheet.sortDescending.value"
          @sort="sheet.sortBy"
          @toggle="sheet.toggleSat"
          @info="showInfo"
        />
        <div class="catalogSheet__globe">
          <button
            type="button"
            class="catalogSheet__globeCount"
            :class="{ 'catalogSheet__globeCount--on': sheet.activeOnly.value }"
            :aria-pressed="sheet.activeOnly.value"
            :title="sheet.activeOnly.value ? 'List every match' : 'List only what the globe shows'"
            @click="sheet.activeOnly.value = !sheet.activeOnly.value"
          >
            <UIcon name="lucide:globe" />
            <span class="cs-num">{{ sheet.active.value.size.toLocaleString() }}</span> on the globe
          </button>
          <span class="catalogSheet__spacer" />
          <button type="button" class="cs-btn" :disabled="sheet.active.value.size === 0" @click="sheet.clearGlobe()"><UIcon name="lucide:eraser" /> Clear globe</button>
        </div>
      </div>
    </div>
    <catalog-custom-dialog v-model:open="customOpen" :loading="sheet.isLoading.value" @added="onCustomAdded" />
  </section>
</template>

<script setup lang="ts">
import "./catalog.css";
import { storeToRefs } from "pinia";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { SHOW_CAP, useCatalogFilters } from "../../composables/useCatalogFilters";
import { useController } from "../../composables/useController";
import { ORBIT_CLASS_HINT, orbitColor, orbitKindHint, SUN_SYNC_COLOR } from "../../config/orbitClass";
import { FACET_BY_KEY, FACETS, type FacetDef, type FacetKey, facetBranches, facetItems, NO_KIND, NO_PROGRAM, parseOrbitLeaf } from "../../modules/catalogFacets";
import { useSatStore } from "../../stores/sat";
import CatalogApsisPlot from "./CatalogApsisPlot.vue";
import CatalogCrossingHistogram from "./CatalogCrossingHistogram.vue";
import CatalogCustomDialog from "./CatalogCustomDialog.vue";
import CatalogFacetDetail from "./CatalogFacetDetail.vue";
import CatalogFacetTile from "./CatalogFacetTile.vue";
import CatalogFacetTree from "./CatalogFacetTree.vue";
import CatalogLaunchHistogram from "./CatalogLaunchHistogram.vue";
import CatalogList from "./CatalogList.vue";
import CatalogShapePlot from "./CatalogShapePlot.vue";

const emit = defineEmits<{ back: []; close: []; expand: []; "show-info": [name: string] }>();

// The catalog, the sheet's state, and the revision that grows as groups load.
const { sats } = useController();
const sheet = useCatalogFilters(sats.catalog);
const { catalogRevision } = storeToRefs(useSatStore());

// A group registered after the sheet opened is fetched too; loadAll skips the loaded ones.
onMounted(() => void sheet.loadAll());
watch(catalogRevision, () => void sheet.loadAll());

/** What an orbit tree row means: a class, a kind, or a class's kindless leaf. */
function orbitHint(value: string): string | undefined {
  if (value in ORBIT_CLASS_HINT) return ORBIT_CLASS_HINT[value as keyof typeof ORBIT_CLASS_HINT];
  const { orbitClass, kind } = parseOrbitLeaf(value);
  return kind === undefined ? "No kind: GCAT names none for these, or does not list them yet" : orbitKindHint(orbitClass, kind);
}

/** A class's colour on its parent row; among the kinds, only sun-sync stands out. */
function orbitTreeColor(value: string): string | undefined {
  const { orbitClass, kind } = parseOrbitLeaf(value);
  const color = orbitColor(orbitClass, kind);
  return kind === undefined || color === SUN_SYNC_COLOR ? color : undefined;
}

/** A tree tile's settings. */
interface Tree {
  def: FacetDef;
  /** Branches shown before "+n more". */
  top: number;
  /** Parents unfolded at first. */
  unfolded?: string[];
  hintOf?: (value: string) => string | undefined;
  colorOf?: (value: string) => string | undefined;
  /** A line under the opened tree. */
  note?: () => string | undefined;
}

/** The orbit and constellation trees. */
const TREES: Tree[] = [
  {
    def: FACET_BY_KEY.orbit,
    top: 4,
    unfolded: ["LEO"],
    hintOf: orbitHint,
    colorOf: orbitTreeColor,
    note: () => {
      const worked = sheet.rows.value.filter((row) => row.orbitKindComputed && row.orbitKind !== undefined).length;
      return worked > 0
        ? `GCAT has no orbit code for ${worked.toLocaleString()} satellites yet, most launched in the last three months; their LEO kind is worked out from the element set by GCAT's bounds, and starred in the list. "${NO_KIND}" collects the rest.`
        : undefined;
    },
  },
  {
    def: FACET_BY_KEY.constellation,
    top: 6,
    note: () => `Grouped by GCAT's programme, under the programme's first word. "${NO_PROGRAM}" collects satellites GCAT does not list yet.`,
  },
];
/** Every facet but the trees, as tiles of bars. */
const FLAT_FACETS = FACETS.filter((def) => !def.parentOf);

/** A facet's values with their counts under the other filters. */
function itemsOf(def: FacetDef) {
  return facetItems(def, sheet.result.value.counts[def.key], sheet.pickedFacets[def.key]);
}
/** A tree facet's values under their parents. */
function branchesOf(def: FacetDef) {
  return facetBranches(def, itemsOf(def));
}

/** Some match is on the globe, so Hide has something to do. */
const anyShown = computed(() => sheet.matched.value.some((row) => sheet.active.value.has(row.name)));

/** Full screen, rather than the sheet. */
const full = ref(false);
// Full screen covers the menu, so a panel left open under it would take the next Escape.
watch(full, (value) => value && emit("expand"));
/** Which half a phone shows; wider screens show both and ignore it. */
const pane = ref<"charts" | "list">("charts");
/** Px, the hero charts' height, taller in full screen. */
const heroHeight = computed(() => (full.value ? 230 : 120));

/** Full screen hides the globe, so showing shrinks back to the sheet to reveal it. */
function show(): void {
  sheet.showOnly(sheet.matched.value);
  full.value = false;
}
/** Like show, but keeps what the globe already shows. */
function add(): void {
  sheet.add(sheet.matched.value);
  full.value = false;
}
/** Selects the satellite and shrinks the sheet, so its info panel shows beside it. */
function showInfo(name: string): void {
  sheet.activateSat(name);
  sats.select(name);
  full.value = false;
  emit("show-info", name);
}

/** The custom satellites dialog is open. */
const customOpen = ref(false);
/** One satellite added shows its info, as a click on its row would. */
function onCustomAdded(names: string[]): void {
  const [only] = names;
  if (names.length === 1 && only !== undefined) {
    showInfo(only);
  } else {
    full.value = false;
  }
}

/** A tile: a hero chart or a facet. */
type TileKey = "launch" | "shape" | "apsides" | "crossing" | FacetKey;

/** The tile opened large, if any. */
const opened = ref<TileKey | null>(null);
/** Px, the opened tile's height: twice what it had, capped. */
const openHeight = ref(0);
/** No opened tile grows past this, nor past the charts column. */
const OPEN_MAX_PX = 520;

/** Each tile's element, measured when it opens. */
const tileEls = new Map<TileKey, HTMLElement>();
/** A function ref that keeps tileEls current. */
function tileRef(key: TileKey) {
  return (el: unknown) => {
    if (el instanceof HTMLElement) tileEls.set(key, el);
    else tileEls.delete(key);
  };
}

// The charts column's height, which caps an opened tile.
const chartsEl = ref<HTMLElement | null>(null);
const chartsHeight = ref(400);
let chartsObserver: ResizeObserver | undefined;
onMounted(() => {
  chartsObserver = new ResizeObserver(([entry]) => {
    if (entry) chartsHeight.value = entry.contentRect.height;
  });
  if (chartsEl.value) chartsObserver.observe(chartsEl.value);
});
onBeforeUnmount(() => chartsObserver?.disconnect());

/** Opens a tile in place at twice its height, capped. */
function open(key: TileKey): void {
  const height = tileEls.get(key)?.offsetHeight ?? 200;
  openHeight.value = Math.max(height, Math.min(2 * height, OPEN_MAX_PX, chartsHeight.value - 20));
  opened.value = key;
  void nextTick(() => tileEls.get(key)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
}
/** Closes the opened tile. */
function close(): void {
  opened.value = null;
}
/** A tile's own toggle in its heading. */
function toggleOpen(key: TileKey): void {
  if (opened.value === key) close();
  else open(key);
}
/** The opened tile's fixed height. */
const openStyle = (key: TileKey) => (opened.value === key ? { height: `${openHeight.value}px` } : undefined);

// A drag on the header resizes the sheet under the pointer; let go past the threshold and it
// snaps to the next size, or closes below the sheet, as a phone's sheet does.
const DRAG_THRESHOLD_PX = 60;
/** Of the window's height: full screen let go below this closes, rather than shrinking. */
const CLOSE_BELOW = 1 / 3;
/** Px of movement before a press becomes a drag, so a click on the grip stays a click. */
const DRAG_SLOP_PX = 4;
const sheetEl = ref<HTMLElement | null>(null);
/** Px, the sheet's height while dragged; null otherwise. */
const dragHeight = ref<number | null>(null);
/** Where the press began and the sheet's height then. */
let press: { pointerId: number; fromY: number; height: number } | null = null;
/** A drag just ended, so the click that follows it is not a click on the grip. */
let justDragged = false;
/** A press on a button or an input, which is not a drag. */
const onControl = (event: Event) => (event.target as HTMLElement).closest("button:not(.catalogSheet__grip), input") !== null;
/**
 * Starts a header drag, unless it began on a control. The press is followed on the window: the
 * grip sits on the header's top edge, so dragging up leaves the header on the first move.
 */
function dragStart(event: PointerEvent): void {
  if (event.button !== 0 || onControl(event) || !sheetEl.value) return;
  press = { pointerId: event.pointerId, fromY: event.clientY, height: sheetEl.value.offsetHeight };
  window.addEventListener("pointermove", dragMove);
  window.addEventListener("pointerup", dragEnd);
  window.addEventListener("pointercancel", dragCancel);
}
/** Past the slop, the sheet's height follows the pointer. */
function dragMove(event: PointerEvent): void {
  if (press?.pointerId !== event.pointerId) return;
  const dy = event.clientY - press.fromY;
  if (dragHeight.value === null && Math.abs(dy) < DRAG_SLOP_PX) return;
  dragHeight.value = Math.min(window.innerHeight, Math.max(press.height - dy, 0));
}
/** Up past the threshold expands; down past it shrinks full screen, or closes the sheet. */
function dragEnd(event: PointerEvent): void {
  if (press?.pointerId !== event.pointerId) return;
  const dy = event.clientY - press.fromY;
  const releasedHeight = press.height - dy;
  const dragged = dragHeight.value !== null;
  dragCancel();
  if (!dragged) return;
  // The click, if any, follows in the same task.
  justDragged = true;
  setTimeout(() => (justDragged = false));
  if (dy < -DRAG_THRESHOLD_PX) full.value = true;
  else if (dy > DRAG_THRESHOLD_PX) {
    if (full.value && releasedHeight >= window.innerHeight * CLOSE_BELOW) full.value = false;
    else emit("close");
  }
}
/** Ends the press; a drag that ends here springs back. */
function dragCancel(): void {
  press = null;
  dragHeight.value = null;
  window.removeEventListener("pointermove", dragMove);
  window.removeEventListener("pointerup", dragEnd);
  window.removeEventListener("pointercancel", dragCancel);
}
onBeforeUnmount(dragCancel);
/** A click on the grip toggles full screen, unless it ends a drag. */
function onGripClick(): void {
  if (!justDragged) full.value = !full.value;
}
/** A double click on the header toggles full screen, as on a window's title bar. */
function onHeadDoubleClick(event: MouseEvent): void {
  if (!onControl(event)) full.value = !full.value;
}

/**
 * Escape closes the innermost thing: an opened tile, then full screen, then the sheet, back
 * to the Satellites panel. Satvis's onEscape calls it, after its own checks for inputs and
 * open dialogs.
 */
function escape(): void {
  if (opened.value) close();
  else if (full.value) full.value = false;
  else emit("back");
}

defineExpose({ escape });
</script>

<style scoped>
/* One box at two sizes: the sheet's insets and height animate to the window's. */
.catalogSheet {
  position: fixed;
  right: 8px;
  bottom: calc(8px + var(--safe-bottom));
  left: 8px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  /* 58% of the window, but at least 380 px (a short laptop) and at most 640 px (a tall monitor). */
  height: clamp(min(380px, calc(100dvh - 16px)), 58dvh, 640px);
  border-radius: 12px;
  background: var(--cs-bg);
  box-shadow: 0 -8px 30px #0008;
  backdrop-filter: blur(8px);
  pointer-events: auto;
  transition:
    left 0.3s ease,
    right 0.3s ease,
    bottom 0.3s ease,
    height 0.3s ease,
    border-radius 0.3s ease,
    background-color 0.3s ease;
}

.catalogSheet--dragging {
  transition: none;
}

/* Over the menu column and its panels, which the half sheet lies under (main.css). */
.catalogSheet--full {
  z-index: 22;
  right: 0;
  bottom: 0;
  left: 0;
  height: 100dvh;
  border-radius: 0;
  background: #1f2224f7;
}

.catalogSheet__head {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  min-height: 52px;
  padding: 10px 10px 4px;
  border-bottom: 1px solid var(--cs-line);
  cursor: grab;
  touch-action: none;
}

.catalogSheet__grip {
  position: absolute;
  top: 2px;
  left: 50%;
  width: 56px;
  height: 12px;
  margin-left: -28px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
}

.catalogSheet__grip::before {
  content: "";
  display: block;
  width: 36px;
  height: 4px;
  margin: 4px auto 0;
  border-radius: 2px;
  background: #ffffff40;
}

.catalogSheet__grip:hover::before {
  background: #ffffff80;
}

.catalogSheet__title {
  font-size: 15px;
  font-weight: 600;
}

.catalogSheet__count {
  font-size: 20px;
  font-weight: 700;
  color: var(--cs-link);
}

/* One line that scrolls sideways, so a new chip never pushes the buttons. */
.catalogSheet__chips {
  display: flex;
  flex: 1;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.catalogSheet__headActions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.catalogSheet__spacer {
  flex: 1;
}

.catalogSheet__tabs {
  display: none;
}

/* The list's width follows the window, not the mode, so its columns stay put on expanding. */
.catalogSheet__body {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 1fr) clamp(290px, 40vw, 640px);
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
}

.catalogSheet__chartsWrap {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.catalogSheet__charts {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding: 10px;
  container: charts / inline-size;
}

.catalogSheet__heroes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}

/* Side by side only where each chart keeps ~270 px; below, they stack. */
@container charts (max-width: 560px) {
  .catalogSheet__heroes {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* Dense, so an opened tile's empty row end is taken by the next tiles, not left as a hole. */
.catalogSheet__facets {
  display: grid;
  grid-auto-flow: row dense;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}

.catalogSheet__tile {
  min-width: 0;
  padding: 8px;
  border-radius: 8px;
  background: var(--cs-raised);
}

/* An opened tile: the whole row, at a fixed height its content scrolls within. */
.catalogSheet__tile--open {
  display: flex;
  flex-direction: column;
  grid-column: 1 / -1;
  overflow-y: auto;
  box-shadow: inset 0 0 0 1px #74c0fc55;
}

.catalogSheet__tile--open > * {
  flex: 1;
  min-height: 0;
}

.catalogSheet__list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--cs-line);
  container: list / inline-size;
}

.catalogSheet__listHead {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}

.catalogSheet__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

@container list (max-width: 320px) {
  .catalogSheet__matchWord {
    display: none;
  }
}

.catalogSheet__cap {
  margin: 0;
  font-size: 11px;
}

.catalogSheet__rows {
  flex: 1;
}

.catalogSheet__globe {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid var(--cs-line);
  background: #00000026;
}

.catalogSheet__globeCount {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--cs-dim);
  font-size: 12px;
  cursor: pointer;
}

.catalogSheet__globeCount:hover {
  background: #ffffff14;
}

.catalogSheet__globeCount--on {
  border-color: #2f9e4499;
  background: var(--cs-accent-soft);
  color: var(--cs-text);
}

/* A phone: an edge-to-edge sheet, the chips on their own row, and tabs instead of two columns. */
@media (max-width: 699px) {
  .catalogSheet {
    right: 0;
    bottom: 0;
    left: 0;
    height: clamp(min(380px, 100dvh), 72dvh, 100dvh);
    border-radius: 14px 14px 0 0;
  }

  .catalogSheet--full {
    height: 100dvh;
    border-radius: 0;
  }

  .catalogSheet__head {
    flex-wrap: wrap;
    row-gap: 6px;
    padding-bottom: 8px;
  }

  .catalogSheet__of,
  .catalogSheet__wide {
    display: none;
  }

  .catalogSheet__chips {
    flex-basis: 100%;
    order: 10;
  }

  .catalogSheet__chips--empty {
    display: none;
  }

  .catalogSheet__tabs {
    display: flex;
    flex: none;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--cs-line);
  }

  .catalogSheet__tabs button {
    display: inline-flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;
    border: 1px solid var(--cs-line);
    border-radius: 8px;
    background: none;
    color: var(--cs-dim);
    font-size: 13px;
    cursor: pointer;
  }

  .catalogSheet__tabs button.on {
    border-color: #2f9e4499;
    background: var(--cs-accent-soft);
    color: var(--cs-text);
  }

  .catalogSheet__badge {
    padding: 0 6px;
    border-radius: 999px;
    background: #ffffff1a;
    font-size: 11px;
  }

  .catalogSheet__body {
    grid-template-columns: minmax(0, 1fr);
  }

  .catalogSheet__body--charts .catalogSheet__list,
  .catalogSheet__body--list .catalogSheet__chartsWrap {
    display: none;
  }

  .catalogSheet__list {
    border-left: none;
  }

  .catalogSheet__facets {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
