<!-- A facet opened in place: every value with its share, a search, sorting and "pick all". -->
<template>
  <div class="facetDetail">
    <div class="cs-tileHead">
      <UIcon :name="def.icon" class="cs-mute" /> {{ def.label }}
      <span class="cs-mute cs-num">{{ formatInteger(items.length) }} values</span>
      <span v-if="picked.size" class="cs-dim cs-num">· {{ picked.size }} picked</span>
      <span class="cs-headEnd">
        <button v-if="picked.size" type="button" class="cs-reset" @click="emit('clear')">reset</button>
        <catalog-tile-toggle :open="true" :label="def.label" @click="emit('toggle-open')" />
      </span>
    </div>

    <div class="facetDetail__tools">
      <div class="cs-search facetDetail__search">
        <UIcon name="lucide:search" class="cs-mute" />
        <input ref="searchEl" v-model="search" :placeholder="`Find ${def.label.toLowerCase()}`" :aria-label="`Find ${def.label.toLowerCase()}`" />
      </div>
      <div v-if="!def.order" class="facetDetail__sorts" role="group" aria-label="Sort">
        <button v-for="mode in SORTS" :key="mode.key" type="button" :class="{ on: sort === mode.key }" :aria-pressed="sort === mode.key" @click="sort = mode.key">
          {{ mode.label }}
        </button>
      </div>
      <button v-if="search && shown.length" type="button" class="cs-btn" @click="emit('pick-many', shownValues)">
        <UIcon name="lucide:check-check" /> Pick all {{ formatInteger(shown.length) }}
      </button>
    </div>

    <div class="facetDetail__grid cs-scroll">
      <button
        v-for="item in shown"
        :key="item.value"
        type="button"
        class="facetDetail__row"
        :class="{ 'facetDetail__row--picked': picked.has(item.value), 'facetDetail__row--dimmed': (picked.size > 0 && !picked.has(item.value)) || item.count === 0 }"
        :aria-pressed="picked.has(item.value)"
        @click="emit('toggle', item.value)"
      >
        <UIcon :name="picked.has(item.value) ? 'lucide:square-check' : 'lucide:square'" class="facetDetail__box" />
        <span class="facetDetail__label" :title="item.value">{{ item.value }}</span>
        <span class="facetDetail__track"><span :style="{ width: `${(item.count / max) * 100}%` }" /></span>
        <span class="facetDetail__count cs-num">{{ formatInteger(item.count) }}</span>
        <span class="facetDetail__share cs-num">{{ share(item.count) }}</span>
      </button>
      <div v-if="!shown.length" class="facetDetail__empty cs-dim">No {{ def.label.toLowerCase() }} matches "{{ search }}".</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import type { FacetDef, FacetItem } from "../../modules/catalogFacets";
import { formatInteger, formatFixed } from "../../modules/util/formats";
import CatalogTileToggle from "./CatalogTileToggle.vue";

const props = defineProps<{ def: FacetDef; items: readonly FacetItem[]; picked: ReadonlySet<string> }>();
const emit = defineEmits<{ toggle: [value: string]; "pick-many": [values: string[]]; clear: []; "toggle-open": [] }>();

/** The sort modes a facet without an order of its own offers. */
const SORTS = [
  { key: "count", label: "Most" },
  { key: "name", label: "A–Z" },
  { key: "picked", label: "Picked first" },
] as const;

// The search and sort the user picked.
const search = ref("");
const sort = ref<(typeof SORTS)[number]["key"]>("count");

/** Every value's count summed, for the shares. */
const total = computed(() => props.items.reduce((sum, item) => sum + item.count, 0));
/** The widest bar's count. */
const max = computed(() => Math.max(1, ...props.items.map((item) => item.count)));

/** A facet with an order of its own keeps it; the others sort as asked. */
const shown = computed(() => {
  const q = search.value.trim().toLowerCase();
  const list = q === "" ? props.items : props.items.filter((item) => item.value.toLowerCase().includes(q));
  if (props.def.order || sort.value === "count") return list;
  if (sort.value === "name") return list.toSorted((a, b) => a.value.localeCompare(b.value));
  return list.toSorted((a, b) => Number(props.picked.has(b.value)) - Number(props.picked.has(a.value)) || b.count - a.count);
});
/** What "pick all" picks. */
const shownValues = computed(() => shown.value.map((item) => item.value));

/** Of the matches under every other filter; a satellite with two values counts in both. */
function share(count: number): string {
  if (total.value === 0 || count === 0) return "";
  const percent = (count / total.value) * 100;
  return percent >= 1 ? `${formatFixed(percent, 0)}%` : "<1%";
}

/** Focused on opening, so typing searches at once. */
const searchEl = ref<HTMLInputElement | null>(null);
onMounted(() => searchEl.value?.focus({ preventScroll: true }));
</script>

<style scoped>
.facetDetail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.facetDetail__tools {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.facetDetail__search {
  flex: 1 1 200px;
  max-width: 320px;
  height: 28px;
}

.facetDetail__sorts {
  display: flex;
  overflow: hidden;
  border: 1px solid var(--cs-line);
  border-radius: 6px;
}

.facetDetail__sorts button {
  padding: 4px 9px;
  border: none;
  border-right: 1px solid var(--cs-line);
  background: none;
  color: var(--cs-dim);
  font-size: 12px;
  cursor: pointer;
}

.facetDetail__sorts button:last-child {
  border-right: none;
}

.facetDetail__sorts button.on {
  background: var(--cs-accent-soft);
  color: var(--cs-text);
}

/* As many columns as fit, one at most the grid's width; values fill each row left to right, most first. */
.facetDetail__grid {
  display: grid;
  flex: 1;
  grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr));
  align-content: start;
  gap: 1px 16px;
  min-height: 0;
}

.facetDetail__row {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) 56px 44px 30px;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 4px;
  border: none;
  border-radius: 3px;
  background: none;
  color: var(--cs-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.facetDetail__row:hover {
  background: #ffffff10;
}

.facetDetail__box {
  color: var(--cs-mute);
}

.facetDetail__row--picked {
  background: var(--cs-accent-soft);
}

.facetDetail__row--picked .facetDetail__box {
  color: #8ce99a;
}

.facetDetail__row--dimmed {
  opacity: 0.5;
}

.facetDetail__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.facetDetail__track {
  height: 8px;
  overflow: hidden;
  border-radius: 2px;
  background: #ffffff0a;
}

.facetDetail__track span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--cs-link);
}

.facetDetail__row--picked .facetDetail__track span {
  background: var(--cs-accent);
}

.facetDetail__count {
  font-size: 11px;
  text-align: right;
  color: var(--cs-dim);
}

.facetDetail__share {
  font-size: 10px;
  text-align: right;
  color: var(--cs-mute);
}

.facetDetail__empty {
  grid-column: 1 / -1;
  padding: 24px;
  text-align: center;
}
</style>
