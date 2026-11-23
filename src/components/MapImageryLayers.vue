<!-- The Map panel's satellite imagery (ADR 0021, 0024): the layers that have not stopped, by orbit, one group open at a time. -->
<template>
  <div class="toolbarTitle" :class="{ 'toolbarTitle--inert': inert }">Satellite imagery</div>
  <!-- Shown while the list loads, or while a layer's record has not, so a layer on the globe can be taken off. -->
  <label v-for="token in unlisted" :key="token" class="toolbarSwitch" :class="{ 'toolbarSwitch--inert': inert }">
    <input type="checkbox" checked @change="cesiumStore.toggleInstrumentImagery(token, false)" />
    {{ cesiumStore.instrumentImageryLabels[token] ?? token.slice(token.indexOf(":") + 1) }}
  </label>
  <!-- The groups wait for every group, so no header or row moves as the rest arrive. -->
  <div v-if="loading" class="toolbarNote">Loading the imagery list…</div>
  <div v-else-if="layers.length === 0" class="toolbarNote">No satellite has imagery.</div>
  <template v-for="group in groups" :key="group.key">
    <button type="button" class="toolbarPlace" :class="{ 'toolbarPlace--inert': inert }" :aria-expanded="openGroup === group.key" @click="toggleGroup(group.key)">
      <UIcon :name="GROUP_ICON[group.key]" class="toolbarPlace__icon" />
      <span class="toolbarPlace__label">{{ GROUP_TITLE[group.key] }}</span>
      <!-- One or the other: both cut the name short in the panel's width. -->
      <span v-if="group.shown" class="countBadge imageryGroup__count">{{ group.shown }} on</span>
      <span v-else class="imageryGroup__count">{{ group.rows.length }}</span>
      <UIcon :name="openGroup === group.key ? 'lucide:chevron-up' : 'lucide:chevron-down'" class="imageryGroup__chevron" />
    </button>
    <template v-if="openGroup === group.key">
      <!-- A satellite or composite a row, a button a layer named by its type. Each button's name
           is fixed: what loads later, the newest pass, is in its tooltip and the notice. -->
      <div
        v-for="row in group.rows"
        :key="row.key"
        class="toolbarSwitch imageryRow"
        :class="{ 'toolbarSwitch--inert': inert, 'imageryRow--on': row.cells.some(({ layer }) => isShown(layer)) }"
      >
        <!-- A composite is no one satellite's: its name opens a menu of its satellites. -->
        <UDropdownMenu v-if="row.composite" :items="satelliteItems(row)" :content="MENU_CONTENT" :ui="MENU_UI" :size="MENU_SIZE">
          <button
            type="button"
            class="imageryRow__name"
            :aria-label="`Show the imagery of a satellite of the ${row.name.toLowerCase()}`"
            title="Show the imagery of one of its satellites"
          >
            {{ row.name }}
          </button>
        </UDropdownMenu>
        <button
          v-else
          type="button"
          class="imageryRow__name"
          :aria-label="`Show the imagery of ${row.name}`"
          :title="`Show the imagery of ${row.name}`"
          @click="showImagery(row.name)"
        >
          {{ shortName(row.name) }}
        </button>
        <span class="imageryRow__buttons">
          <template v-for="cell in row.cells" :key="cell.layer.key">
            <template v-if="!cell.extra || isShown(cell.layer)">
              <button
                type="button"
                class="imageryButton"
                :class="{ 'imageryButton--on': isShown(cell.layer) }"
                :aria-pressed="isShown(cell.layer)"
                :aria-label="buttonLabel(row, cell)"
                :title="tooltipOf(cell.layer)"
                @click="cesiumStore.toggleInstrumentImagery(cell.layer.token, !isShown(cell.layer))"
              >
                <UIcon :name="IMAGERY_TYPES[cell.layer.type].icon" />
                {{ cell.name }}
              </button>
            </template>
          </template>
        </span>
        <template v-for="{ layer } in row.cells" :key="layer.key">
          <PassNotice
            v-if="layer.type === 'passes' && isShown(layer) && isPastNewest(layer.token)"
            class="imageryRow__notice"
            :newest="latest.get(layer.token)!.pictured.start"
            :now="wallClock"
            @go="goToNewest(layer.token)"
          />
        </template>
      </div>
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
import { granuleLayerOwner, IMAGERY_GROUPS, IMAGERY_TYPES, type ImageryGroup, type ImageryLayer, imageryLayers, type ImageryRow, imageryRows } from "@/config/instrumentImagery";
import { DeviceDetect } from "@/modules/util/DeviceDetect";
import { timeAgo } from "@/modules/util/formats";
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

/** Selects the satellite, turning it on if need be, at its info panel's Imagery tab. */
function showImagery(name: string): void {
  showSatellite(name, "imagery");
  emit("show-info", name);
}

/** The satellites of a row's composites, each opening its Imagery tab. */
function satelliteItems(row: ImageryRow): DropdownMenuItem[] {
  const names = new Set(row.cells.flatMap(({ layer }) => (layer.kind === "composite" ? layer.satellites : [])));
  return [
    { type: "label", label: "Show the imagery of" },
    ...[...names]
      .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => ({ label: name, icon: "lucide:satellite", onSelect: () => showImagery(name) })),
  ];
}

/** The groups that have a layer, each with its rows and how many of its layers are on; none while the list loads. */
const groups = computed(() => {
  if (loading.value) return [];
  return IMAGERY_GROUPS.map((key) => {
    const members = layers.value.filter((layer) => layer.group === key);
    return { key, rows: imageryRows(members), shown: members.filter(isShown).length };
  }).filter((group) => group.rows.length > 0);
});
/** Layers on the globe that no row shows: every one while the list loads. */
const unlisted = computed(() => {
  const listed = new Set(loading.value ? [] : layers.value.map((layer) => layer.token));
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

/** The newest pass of each passes layer of the open group, once the list has loaded. */
const { latest, wallClock, isPastNewest, goToNewest } = useLatestPasses(() => {
  const rows = groups.value.find((group) => group.key === openGroup.value)?.rows ?? [];
  return rows.flatMap((row) =>
    row.cells.flatMap(({ layer }) => {
      const owner = layer.type === "passes" ? granuleLayerOwner(sats.catalog.entries, layer.token) : undefined;
      return owner === undefined ? [] : [{ key: layer.token, layer: owner.layer }];
    }),
  );
});

/** "Daily mosaic of PACE", "Daily mosaic of PACE SPEXone" for a second of its type, "World mosaic, Day/Night". */
function buttonLabel(row: ImageryRow, { layer, name, extra }: ImageryRow["cells"][number]): string {
  return row.composite ? `${row.name}, ${name}` : `${IMAGERY_TYPES[layer.type].title} of ${row.name}${extra ? ` ${name}` : ""}`;
}
/** What the layer is, as its card says it, and for passes how old the newest is, once known. */
function tooltipOf(layer: ImageryLayer): string {
  const newest = layer.type === "passes" ? latest.get(layer.token)?.pictured.start : undefined;
  return [
    IMAGERY_TYPES[layer.type].title,
    layer.words.picture,
    layer.words.cropped,
    layer.words.updates,
    newest === undefined ? undefined : `Newest pass ${timeAgo(newest, wallClock.value)}`,
  ]
    .filter(Boolean)
    .join("\n");
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

/* A satellite or composite and its layers' buttons, on one line where they fit; a pass notice under them. */
.imageryRow {
  display: flex;
  flex-wrap: wrap;
  height: auto;
  min-height: var(--toolbar-row);
  align-items: center;
  gap: 4px 6px;
  padding: 4px 8px 4px 12px;
  white-space: normal;
}

/* The hairline above a row starts at its name, as on the other cards; these rows have no mark before it. */
.imageryRow.imageryRow::before {
  left: 12px;
}

.imageryRow--on {
  color: var(--panel-ink);
}

.imageryRow__name {
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
  .imageryRow__name:hover {
    text-decoration: underline;
  }
}

.imageryRow__buttons {
  display: flex;
  flex: none;
  gap: 4px;
  margin-left: auto;
}

.imageryRow__notice {
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

:is(.imageryRow__name, .imageryButton):focus-visible {
  outline: 2px solid var(--panel-accent);
  outline-offset: 1px;
}
</style>
