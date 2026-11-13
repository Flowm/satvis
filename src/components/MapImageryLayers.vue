<!-- The Map panel's instrument imagery (ADR 0021): every layer in groups, one group open at a time. -->
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
      <span v-else class="imageryGroup__count">{{ group.layers.length }}</span>
      <UIcon :name="openGroup === group.key ? 'lucide:chevron-up' : 'lucide:chevron-down'" class="imageryGroup__chevron" />
    </button>
    <template v-if="openGroup === group.key">
      <label v-for="layer in group.layers" :key="layer.key" class="toolbarSwitch" :class="{ 'toolbarSwitch--inert': inert }" :title="titleOf(layer)">
        <input type="checkbox" :checked="isShown(layer)" @change="cesiumStore.toggleInstrumentImagery(layer.token, ($event.target as HTMLInputElement).checked)" />
        {{ shortName(layer.satellite) }} · {{ layer.label }}
      </label>
    </template>
  </template>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import { useController } from "@/composables/useController";
import { IMAGERY_GROUPS, type ImageryGroup, type ImageryLayer, imageryLayers } from "@/config/instrumentImagery";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

const props = defineProps<{
  /** The Map panel is open: the list is read off the records, so its first opening loads every group. */
  open: boolean;
  /** Dimmed with the panel's other layers, as in the sky view. */
  inert: boolean;
}>();

/** A group's row, as the panel names it. */
const GROUP_TITLE: Record<ImageryGroup, string> = {
  geo: "GEO satellites",
  leo: "LEO satellites",
};
const GROUP_ICON: Record<ImageryGroup, string> = {
  geo: "lucide:earth",
  leo: "lucide:orbit",
};

const { sats } = useController();
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
/** The row's tooltip: the whole satellite name, the instrument and when it has frames. */
const titleOf = (layer: ImageryLayer) => [[layer.satellite, layer.instrument].filter(Boolean).join(" "), layer.label, layer.detail].filter(Boolean).join(" · ");

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
</style>
