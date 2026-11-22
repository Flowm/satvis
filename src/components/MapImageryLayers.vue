<!-- The Map panel's satellite imagery (ADR 0021, 0024): the layers that have not stopped, by orbit, one group open at a time. -->
<template>
  <div class="toolbarTitle" :class="{ 'toolbarTitle--inert': inert }">Satellite imagery</div>
  <!-- Shown before the list arrives, or while its record has not loaded, so a layer on the globe can be taken off. -->
  <label v-for="token in unlisted" :key="token" class="toolbarSwitch" :class="{ 'toolbarSwitch--inert': inert }">
    <input type="checkbox" checked @change="cesiumStore.toggleInstrumentImagery(token, false)" />
    {{ cesiumStore.instrumentImageryLabels[token] ?? token.slice(token.indexOf(":") + 1) }}
  </label>
  <div v-if="layers.length === 0" class="toolbarNote">{{ loading ? "Loading the imagery list…" : "No satellite has imagery." }}</div>
  <template v-for="group in groups" :key="group.key">
    <button type="button" class="toolbarPlace" :class="{ 'toolbarPlace--inert': inert }" :aria-expanded="openGroup === group.key" @click="toggleGroup(group.key)">
      <UIcon :name="GROUP_ICON[group.key]" class="toolbarPlace__icon" />
      <span class="toolbarPlace__label">{{ GROUP_TITLE[group.key] }}</span>
      <!-- One or the other: both cut the name short in the panel's width. -->
      <span v-if="group.shown" class="countBadge imageryGroup__count">{{ group.shown }} on</span>
      <span v-else class="imageryGroup__count">{{
        group.key === "leo" ? leoRows.length + group.layers.filter((each) => each.kind === "composite").length : group.layers.length
      }}</span>
      <UIcon :name="openGroup === group.key ? 'lucide:chevron-up' : 'lucide:chevron-down'" class="imageryGroup__chevron" />
    </button>
    <template v-if="openGroup === group.key && group.key === 'leo'">
      <div class="toolbarNote imageryLegend">
        <span><UIcon :name="IMAGERY_TYPES.daily.icon" /> Daily: the whole day at once</span>
        <span><UIcon name="lucide:play" /> Replays the newest pass</span>
      </div>
      <!-- A satellite a row, without its instruments: each layer a button named by its type. The
           passes, which show nothing until the clock is at one, start as a replay of the newest. -->
      <div
        v-for="row in leoRows"
        :key="row.satellite"
        class="toolbarSwitch imagerySatellite"
        :class="{ 'toolbarSwitch--inert': inert, 'imagerySatellite--on': row.layers.some(({ layer }) => isShown(layer)) }"
      >
        <button
          type="button"
          class="imagerySatellite__name"
          :aria-label="`Show the imagery of ${row.satellite}`"
          :title="`Show the imagery of ${row.satellite}`"
          @click="showImagery(row.satellite)"
        >
          {{ shortName(row.satellite) }}
        </button>
        <span class="imagerySatellite__buttons">
          <template v-for="{ layer, name } in row.layers" :key="layer.key">
            <button
              v-if="layer.type === 'passes' && !isShown(layer)"
              type="button"
              class="imageryButton imageryButton--replay"
              :aria-label="`Replay the newest pass of ${row.satellite}`"
              :title="`Shows ${shortName(row.satellite)}'s passes from just before its newest one`"
              @click="replay(row.satellite, layer)"
            >
              <UIcon name="lucide:play" />
              {{ newestOf(layer) === undefined ? "Newest pass" : timeAgo(newestOf(layer)!) }}
            </button>
            <button
              v-else
              type="button"
              class="imageryButton"
              :class="{ 'imageryButton--on': isShown(layer) }"
              :aria-pressed="isShown(layer)"
              :aria-label="buttonLabel(row.satellite, layer, name)"
              :title="tooltipOf(layer)"
              @click="cesiumStore.toggleInstrumentImagery(layer.token, !isShown(layer))"
            >
              <UIcon :name="IMAGERY_TYPES[layer.type].icon" />
              {{ name }}
            </button>
          </template>
        </span>
        <template v-for="{ layer } in row.layers" :key="layer.key">
          <PassNotice
            v-if="layer.type === 'passes' && isShown(layer) && isPastNewest(layer.token)"
            class="imagerySatellite__notice"
            :newest="newestOf(layer)!"
            @go="goToNewest(layer.token)"
          />
        </template>
      </div>
    </template>
    <template v-if="openGroup === group.key">
      <!-- A press on the button, interactive content inside the label, does not toggle the checkbox.
           A composite's is no one satellite's: it opens a menu of its satellites. The tooltip is the
           text's, so that the button's own shows over it. -->
      <label
        v-for="layer in group.key === 'leo' ? group.layers.filter((each) => each.kind === 'composite') : group.layers"
        :key="layer.key"
        class="toolbarSwitch imageryRow"
        :class="{ 'toolbarSwitch--inert': inert }"
      >
        <input
          type="checkbox"
          :checked="isShown(layer)"
          :aria-label="layer.kind === 'composite' ? layer.label : `${layer.satellite} ${layer.instrument} ${layer.label}`"
          @change="cesiumStore.toggleInstrumentImagery(layer.token, ($event.target as HTMLInputElement).checked)"
        />
        <span class="imageryRow__text" :title="titleOf(layer)">
          <template v-if="layer.kind === 'composite'">
            <span class="imageryRow__name">{{ layer.name }}</span> <span class="imageryRow__instrument">{{ layer.cadence }}</span>
          </template>
          <template v-else>
            <span class="imageryRow__name">{{ shortName(layer.satellite) }}</span> <span class="imageryRow__instrument">{{ layer.instrument }}</span>
          </template>
          <span class="imageryRow__product">{{ layer.product }}</span>
        </span>
        <UDropdownMenu v-if="layer.kind === 'composite'" :items="satelliteItems(layer)" :content="MENU_CONTENT" :ui="MENU_UI" :size="MENU_SIZE">
          <button type="button" class="imageryRow__info" :aria-label="`Show the imagery of a satellite of the ${layer.name}`" title="Show the imagery of one of its satellites">
            <UIcon name="lucide:image" />
          </button>
        </UDropdownMenu>
        <button
          v-else
          type="button"
          class="imageryRow__info"
          :aria-label="`Show the imagery of ${layer.satellite}`"
          :title="`Show the imagery of ${layer.satellite}`"
          @click="showImagery(layer.satellite)"
        >
          <UIcon name="lucide:image" />
        </button>
      </label>
    </template>
  </template>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import { useController } from "@/composables/useController";
import { useLatestPasses } from "@/composables/useLatestPasses";
import { useSelectedEntity } from "@/composables/useSelectedEntity";
import {
  type CompositeImageryLayer,
  granuleLayerOwner,
  IMAGERY_GROUPS,
  IMAGERY_TYPES,
  type ImageryGroup,
  type ImageryLayer,
  imageryLayers,
  imageryRowsBySatellite,
  type SatelliteImageryLayer,
} from "@/config/instrumentImagery";
import { timeAgo } from "@/modules/util/bookmarks";
import { DeviceDetect } from "@/modules/util/DeviceDetect";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

import PassNotice from "./PassNotice.vue";

const props = defineProps<{
  /** The Map panel is open: the list is read off the records, so its first opening loads every group. */
  open: boolean;
  /** Dimmed with the panel's other layers, as in the sky view. */
  inert: boolean;
}>();

const emit = defineEmits<{ "show-info": [name: string] }>();

/** A group's row, as the panel names it. */
const GROUP_TITLE: Record<ImageryGroup, string> = {
  geo: "GEO satellites",
  leo: "LEO satellites",
};
/** A composite's menu of satellites: under its button, at the row's end. */
const MENU_CONTENT = { side: "bottom", align: "end", sideOffset: 2 } as const;
/** BookmarkCard's surface, and `dark`, as the menu is portalled out of `#app`. */
const MENU_UI = { content: "dark bg-(--panel-surface)/95 text-(--panel-ink) ring-white/10" };
/** Rows a finger can hit. */
const MENU_SIZE = DeviceDetect.hasTouch() ? "xl" : "md";

/** A group's mark. */
const GROUP_ICON: Record<ImageryGroup, string> = {
  geo: "lucide:earth",
  leo: "lucide:orbit",
};

const controller = useController();
const { sats } = controller;
const { showSatellite } = useSelectedEntity(controller);
const cesiumStore = useCesiumStore();
const { catalogRevision } = storeToRefs(useSatStore());

/** Every layer of the records loaded so far. */
const layers = computed(() => {
  void catalogRevision.value;
  return imageryLayers(sats.catalog.entries);
});

/** Every group is being loaded. */
const loading = ref(false);
watch(
  () => props.open,
  (open) => {
    if (open && !sats.catalog.allLoaded && !loading.value) {
      loading.value = true;
      void sats.catalog.ensureAll().finally(() => (loading.value = false));
    }
  },
  { immediate: true },
);

/** It is on the globe. */
const isShown = (layer: ImageryLayer) => cesiumStore.instrumentImagery.includes(layer.token);
/** "METEOSAT-12", not "METEOSAT-12 (MTG-I1)": the row is narrow, its title has the whole name. */
const shortName = (name: string) => name.replace(/\s*\(.*\)$/, "");
/** The row's tooltip: the whole satellite name and instrument, or a composite's satellites, then what the picture is and when it has frames. */
const titleOf = (layer: ImageryLayer) =>
  [layer.kind === "composite" ? `${layer.name} of ${layer.satellites.join(", ")}` : `${layer.satellite} ${layer.instrument}`, layer.label, layer.detail].filter(Boolean).join("\n");

/** Selects the satellite, turning it on if need be, at its info panel's Imagery tab. */
function showImagery(name: string): void {
  showSatellite(name, "imagery");
  emit("show-info", name);
}

/** A composite's satellites, each opening its Imagery tab. */
const satelliteItems = (layer: CompositeImageryLayer): DropdownMenuItem[] => [
  { type: "label", label: "Show the imagery of" },
  ...layer.satellites.map((name) => ({ label: name, icon: "lucide:satellite", onSelect: () => showImagery(name) })),
];

/** The groups that have a layer, each with how many of its layers are on. */
const groups = computed(() =>
  IMAGERY_GROUPS.map((key) => {
    const members = layers.value.filter((layer) => layer.group === key);
    return { key, layers: members, shown: members.filter(isShown).length };
  }).filter((group) => group.layers.length > 0),
);
/** Layers on the globe that no listed layer is. */
const unlisted = computed(() => {
  const listed = new Set(layers.value.map((layer) => layer.token));
  return [...new Set(cesiumStore.instrumentImagery)].filter((token) => !listed.has(token));
});

/** The group the user opened, or null for none; undefined until they choose. */
const chosen = ref<ImageryGroup | null>();
/** Until the user chooses, the first group with a layer on. */
const openGroup = computed(() => (chosen.value === undefined ? (groups.value.find((group) => group.shown > 0)?.key ?? null) : chosen.value));
/** Opens the group, closing the one open, or closes it. */
function toggleGroup(key: ImageryGroup): void {
  chosen.value = openGroup.value === key ? null : key;
}

/** The LEO group's satellites, a row each (ADR 0024). */
const leoRows = computed(() => imageryRowsBySatellite(layers.value.filter((layer): layer is SatelliteImageryLayer => layer.group === "leo" && layer.kind === "satellite")));

/** The newest pass of each LEO passes layer, asked while the group is open. */
const { latest, isPastNewest, goToNewest } = useLatestPasses(() => {
  if (openGroup.value !== "leo") return [];
  return leoRows.value.flatMap((row) =>
    row.layers.flatMap(({ layer }) => {
      const owner = layer.type === "passes" ? granuleLayerOwner(sats.catalog.entries, layer.token) : undefined;
      return owner === undefined ? [] : [{ key: layer.token, layer: owner.layer }];
    }),
  );
});
/** The start of the layer's newest pass, epoch ms, once known. */
const newestOf = (layer: SatelliteImageryLayer) => latest.get(layer.token)?.newest.start;

/** "Daily mosaic of PACE", or "Daily mosaic of PACE SPEXone" where the button is named by its instrument. */
const buttonLabel = (satellite: string, layer: SatelliteImageryLayer, name: string) =>
  `${IMAGERY_TYPES[layer.type].title} of ${satellite}${name === layer.instrument ? ` ${layer.instrument}` : ""}`;
/** What the layer is, as its card says it. */
const tooltipOf = (layer: SatelliteImageryLayer) => [IMAGERY_TYPES[layer.type].title, layer.words.picture, layer.words.updates].filter(Boolean).join("\n");

/** The passes on, the clock just before the newest, and the satellite selected at its Imagery tab. */
function replay(satellite: string, layer: SatelliteImageryLayer): void {
  cesiumStore.toggleInstrumentImagery(layer.token, true);
  goToNewest(layer.token);
  showImagery(satellite);
}
</script>

<style scoped>
.imageryGroup__count {
  margin-left: auto;
  color: var(--panel-muted);
}

.imageryGroup__chevron {
  flex: none;
  color: var(--panel-muted);
}

.toolbarPlace--inert {
  color: var(--panel-faint);
}

/* The satellite, its instrument and the picture, then the button that opens the satellite's Imagery tab.
   One line, 32px as the other switches, or two where the name leaves the rest no room. */
.imageryRow {
  display: flex;
  height: auto;
  min-height: var(--toolbar-row);
  align-items: center;
  padding-block: 6px;
  padding-right: 0;
  line-height: 20px;
}

.imageryRow__text {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 5px;
  min-width: 0;
  padding-right: 4px;
}

/* Alone on its line, the name gives way; the instrument and the picture tell two rows of one satellite apart. */
.imageryRow__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.imageryRow__instrument {
  flex: none;
  color: var(--panel-muted);
  font-size: var(--text-note);
}

.imageryRow__product {
  flex: none;
  margin-left: auto;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--panel-selected);
  font-size: 11px;
  line-height: 16px;
}

/* A phone's panel is too narrow for one line (PHONE_WIDTH, src/config/layout.ts): the instrument and the picture go under the name. */
@media (max-width: 639px) {
  .imageryRow__name {
    flex-basis: 100%;
  }

  .imageryRow__product {
    margin-left: 0;
  }
}

/* The LEO group's key to its buttons. */
.imageryLegend {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  padding: 0 4px 6px;
}

.imageryLegend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* A satellite and its layers' buttons, on one line where they fit; a pass notice under them. */
.imagerySatellite {
  display: flex;
  flex-wrap: wrap;
  height: auto;
  min-height: var(--toolbar-row);
  align-items: center;
  gap: 4px 6px;
  padding: 4px 8px 4px 12px;
  white-space: normal;
}

.imagerySatellite--on {
  color: var(--panel-ink);
}

.imagerySatellite__name {
  flex: 1 0 auto;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

@media (hover: hover) {
  .imagerySatellite__name:hover {
    text-decoration: underline;
  }
}

.imagerySatellite__buttons {
  display: flex;
  flex: none;
  gap: 4px;
  margin-left: auto;
}

.imagerySatellite__notice {
  flex-basis: 100%;
}

.imageryButton {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border: 1px solid var(--panel-hairline);
  border-radius: 999px;
  background: none;
  color: var(--panel-muted);
  font-size: 11.5px;
  line-height: 22px;
  cursor: pointer;
}

@media (hover: hover) {
  .imageryButton:hover {
    border-color: var(--panel-faint);
    color: var(--panel-ink);
  }
}

.imageryButton--on,
.imageryButton--on:hover {
  border-color: var(--panel-accent);
  background: color-mix(in srgb, var(--panel-accent) 22%, transparent);
  color: var(--panel-ink);
}

/* An action, not a switch: it sets the clock. */
.imageryButton--replay {
  border-style: dashed;
}

:is(.imagerySatellite__name, .imageryButton):focus-visible {
  outline: 2px solid var(--panel-accent);
  outline-offset: 1px;
}

/* The row's whole height, through its padding. */
.imageryRow__info {
  display: grid;
  flex: none;
  align-self: stretch;
  width: 32px;
  margin-block: -6px;
  margin-right: 2px;
  place-items: center;
  padding: 0;
  border: none;
  background: none;
  color: var(--panel-muted);
  cursor: pointer;
}

@media (hover: hover) {
  .imageryRow__info:hover {
    color: var(--panel-ink);
  }
}

.imageryRow__info:focus-visible {
  outline: 2px solid var(--panel-accent);
  outline-offset: -2px;
}
</style>
