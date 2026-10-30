<!-- One facet as a bar per value: a click picks the value, and a picked facet dims the others. -->
<template>
  <div class="facetTile">
    <div class="cs-tileHead">
      <UIcon :name="def.icon" class="cs-mute" /> {{ def.label }}
      <span class="cs-headEnd">
        <button v-if="picked.size" type="button" class="cs-reset" @click="emit('clear')">reset</button>
        <catalog-tile-toggle :open="false" :label="def.label" @click="emit('toggle-open')" />
      </span>
    </div>
    <button
      v-for="item in shown"
      :key="item.value"
      type="button"
      class="facetTile__row"
      :class="{ 'facetTile__row--picked': picked.has(item.value), 'facetTile__row--dimmed': picked.size > 0 && !picked.has(item.value) }"
      :title="`${item.value}: ${formatInteger(item.count)}`"
      :aria-pressed="picked.has(item.value)"
      @click="emit('toggle', item.value)"
    >
      <span class="facetTile__label">{{ item.value }}</span>
      <span class="facetTile__track"><span :style="{ width: `${(item.count / max) * 100}%` }" /></span>
      <span class="facetTile__count cs-num">{{ formatInteger(item.count) }}</span>
    </button>
    <button v-if="items.length > top" type="button" class="facetTile__more" @click="emit('toggle-open')">+{{ formatInteger(items.length - top) }} more</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import { type FacetDef, type FacetItem, pickedFirst } from "../../modules/catalogFacets";
import { formatInteger } from "../../modules/util/formats";
import CatalogTileToggle from "./CatalogTileToggle.vue";

const props = defineProps<{
  def: FacetDef;
  items: readonly FacetItem[];
  picked: ReadonlySet<string>;
  /** Rows shown before "+n more", which opens the tile. */
  top: number;
}>();
const emit = defineEmits<{ toggle: [value: string]; clear: []; "toggle-open": [] }>();

/** The picked values first, so a pick never hides behind "+n more". */
const shown = computed(() => pickedFirst(props.items, (item) => props.picked.has(item.value), props.top));
/** The widest bar's count. */
const max = computed(() => Math.max(1, ...props.items.map((item) => item.count)));
</script>

<style scoped>
.facetTile {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.facetTile__row {
  display: grid;
  grid-template-columns: minmax(0, 52%) 1fr 44px;
  align-items: center;
  gap: 6px;
  height: 20px;
  padding: 0 4px;
  border: none;
  border-radius: 3px;
  background: none;
  color: var(--cs-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.facetTile__row:hover {
  background: #ffffff10;
}

.facetTile__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.facetTile__track {
  height: 10px;
  overflow: hidden;
  border-radius: 2px;
  background: #ffffff0a;
}

.facetTile__track span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--cs-link);
  transition: width 0.25s;
}

.facetTile__count {
  font-size: 11px;
  text-align: right;
  color: var(--cs-dim);
}

.facetTile__row--picked {
  background: var(--cs-accent-soft);
}

.facetTile__row--picked .facetTile__track span {
  background: var(--cs-accent);
}

.facetTile__row--dimmed {
  opacity: 0.45;
}

.facetTile__more {
  align-self: flex-start;
  margin-top: 2px;
  padding: 0 4px;
  border: none;
  background: none;
  color: var(--cs-link);
  font-size: 11px;
  cursor: pointer;
}
</style>
