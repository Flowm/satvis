<!-- A tree facet: each parent once, folding into its leaves; a parent picks every leaf it has. -->
<template>
  <div class="facetTree" :class="{ 'facetTree--open': open }">
    <div class="cs-tileHead">
      <UIcon :name="def.icon" class="cs-mute" /> {{ def.label }}
      <span v-if="open" class="cs-mute cs-num">{{ branches.length.toLocaleString() }}</span>
      <span class="cs-headEnd">
        <button v-if="picked.size" type="button" class="cs-reset" @click="emit('clear')">reset</button>
        <catalog-tile-toggle :open="open" :label="def.label" @click="emit('toggle-open')" />
      </span>
    </div>
    <div v-if="open && branches.length > SEARCH_FROM" class="cs-search facetTree__search">
      <UIcon name="lucide:search" class="cs-mute" />
      <input v-model="search" :placeholder="`Find ${def.label.toLowerCase()}`" :aria-label="`Find ${def.label.toLowerCase()}`" />
    </div>
    <div class="facetTree__rows" :class="{ 'cs-scroll': open }">
      <template v-for="branch in shown" :key="branch.parent">
        <div class="facetTree__row" :class="rowClass(stateOf(branch))">
          <button
            v-if="isFolding(branch)"
            type="button"
            class="facetTree__fold"
            :aria-label="unfolded.has(branch.parent) ? `Fold ${branch.parent}` : `Unfold ${branch.parent}`"
            :aria-expanded="unfolded.has(branch.parent)"
            @click="toggleFold(branch.parent)"
          >
            <UIcon :name="unfolded.has(branch.parent) ? 'lucide:chevron-down' : 'lucide:chevron-right'" />
          </button>
          <span v-else class="facetTree__fold" />
          <button
            type="button"
            class="facetTree__pick facetTree__pick--parent"
            :title="hintOf?.(branch.parent)"
            :aria-pressed="stateOf(branch) === 'all'"
            @click="emit('toggle-parent', branch.parent)"
          >
            <span class="facetTree__label" :style="{ color: colorOf?.(branch.parent) }">{{ branch.parent }}</span>
            <span class="facetTree__track"><span :style="{ width: `${width(branch.count)}%`, background: colorOf?.(branch.parent) }" /></span>
            <span class="facetTree__count cs-num">{{ branch.count.toLocaleString() }}</span>
            <span v-if="open" class="facetTree__hint">{{ hintOf?.(branch.parent) }}</span>
          </button>
        </div>
        <template v-if="isFolding(branch) && unfolded.has(branch.parent)">
          <div v-for="leaf in branch.leaves" :key="leaf.value" class="facetTree__row facetTree__row--leaf" :class="rowClass(picked.has(leaf.value) ? 'all' : 'none')">
            <span class="facetTree__fold facetTree__elbow" />
            <button type="button" class="facetTree__pick" :title="hintOf?.(leaf.value)" :aria-pressed="picked.has(leaf.value)" @click="emit('toggle', leaf.value)">
              <span class="facetTree__label" :style="{ color: colorOf?.(leaf.value) }">{{ leafLabel(branch.parent, leaf.value) }}</span>
              <span class="facetTree__track"><span :style="{ width: `${width(leaf.count)}%`, background: colorOf?.(leaf.value) }" /></span>
              <span class="facetTree__count cs-num">{{ leaf.count.toLocaleString() }}</span>
              <span v-if="open" class="facetTree__hint">{{ hintOf?.(leaf.value) }}</span>
            </button>
          </div>
        </template>
      </template>
      <button v-if="!open && branches.length > top" type="button" class="facetTree__more" @click="emit('toggle-open')">+{{ (branches.length - top).toLocaleString() }} more</button>
      <div v-if="open && shown.length === 0" class="facetTree__empty cs-dim">No {{ def.label.toLowerCase() }} matches "{{ search }}".</div>
    </div>
    <p v-if="open && note" class="facetTree__note cs-mute">{{ note }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

import { type FacetBranch, type FacetDef, pickedFirst } from "../../modules/catalogFacets";
import CatalogTileToggle from "./CatalogTileToggle.vue";

const props = defineProps<{
  def: FacetDef;
  branches: readonly FacetBranch[];
  picked: ReadonlySet<string>;
  open: boolean;
  /** Branches shown before "+n more", which opens the tile. */
  top: number;
  /** Parents unfolded at first. */
  unfoldedAtFirst?: readonly string[];
  /** What a parent or leaf means, shown opened and on hover. */
  hintOf?: (value: string) => string | undefined;
  colorOf?: (value: string) => string | undefined;
  /** A line under the opened tree. */
  note?: string;
}>();
/** `toggle-parent` names the parent: picking it picks every leaf it has across the catalog, not only these. */
const emit = defineEmits<{ toggle: [value: string]; "toggle-parent": [parent: string]; clear: []; "toggle-open": [] }>();

/** A tree this long gets a search box when opened. */
const SEARCH_FROM = 12;

/** How much of a branch is picked. */
type State = "all" | "some" | "none";

/** The parents shown open. */
const unfolded = ref(new Set(props.unfoldedAtFirst ?? []));
/** The opened tree's search. */
const search = ref("");

/** Folds or unfolds a parent. */
function toggleFold(parent: string): void {
  const next = new Set(unfolded.value);
  if (next.has(parent)) next.delete(parent);
  else next.add(parent);
  unfolded.value = next;
}

/** A branch whose one leaf is the parent itself is a plain row. */
const isFolding = (branch: FacetBranch) => !(branch.leaves.length === 1 && branch.leaves[0]!.value === branch.parent);

/** A leaf's own name, or the part of it after its parent's: "Starlink 2MO S1" under Starlink is "2MO S1". */
function leafLabel(parent: string, value: string): string {
  if (props.def.leafLabel) return props.def.leafLabel(value);
  const rest = value.startsWith(parent) ? value.slice(parent.length).replace(/^[\s-]+/, "") : "";
  return rest === "" ? value : rest;
}

/** How many of a branch's leaves are picked. */
function stateOf(branch: FacetBranch): State {
  const picked = branch.leaves.filter((leaf) => props.picked.has(leaf.value)).length;
  return picked === 0 ? "none" : picked === branch.leaves.length ? "all" : "some";
}

/** A row's classes by its picked state. */
const rowClass = (state: State) => ({
  "facetTree__row--picked": state === "all",
  "facetTree__row--partly": state === "some",
  "facetTree__row--dimmed": props.picked.size > 0 && state === "none",
});

/** Picked branches first when folded, so a pick never hides behind "+n more"; opened, the search narrows them. */
const shown = computed(() => {
  if (props.open) {
    const q = search.value.trim().toLowerCase();
    return q === ""
      ? props.branches
      : props.branches.filter((branch) => branch.parent.toLowerCase().includes(q) || branch.leaves.some((leaf) => leaf.value.toLowerCase().includes(q)));
  }
  return pickedFirst(props.branches, (branch) => stateOf(branch) !== "none", props.top);
});

/** The widest branch's count. */
const max = computed(() => Math.max(1, ...props.branches.map((branch) => branch.count)));
/** Linear like the other facets, but never thinner than a sliver, so a small class stays visible. */
const width = (count: number) => (count === 0 ? 0 : Math.max(1.5, (count / max.value) * 100));
</script>

<style scoped>
.facetTree {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.facetTree__search {
  flex: none;
  max-width: 320px;
  height: 28px;
  margin-bottom: 6px;
}

.facetTree__rows {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
}

.facetTree--open .facetTree__rows {
  flex: 1;
}

.facetTree__row {
  display: flex;
  flex: none;
  align-items: center;
  height: 20px;
  border-radius: 3px;
}

.facetTree--open .facetTree__row {
  height: 26px;
}

.facetTree__fold {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 20px;
  padding: 0;
  border: none;
  background: none;
  color: var(--cs-dim);
  cursor: pointer;
}

.facetTree__row--leaf .facetTree__fold {
  margin-left: 6px;
}

/* A leaf's elbow, so its row reads as part of the parent's. */
.facetTree__elbow::before {
  content: "";
  position: absolute;
  top: -2px;
  left: 2px;
  width: 7px;
  height: 12px;
  border-bottom: 1px solid #ffffff33;
  border-left: 1px solid #ffffff33;
}

.facetTree__pick {
  display: grid;
  flex: 1;
  grid-template-columns: minmax(0, 42%) 1fr 48px;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 100%;
  padding: 0 4px;
  border: none;
  border-radius: 3px;
  background: none;
  color: var(--cs-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.facetTree--open .facetTree__pick {
  grid-template-columns: minmax(120px, 180px) minmax(100px, 1fr) 60px minmax(0, 1.6fr);
  gap: 12px;
  font-size: 13px;
}

.facetTree__pick:hover {
  background: #ffffff10;
}

.facetTree__pick--parent .facetTree__label {
  font-weight: 600;
}

.facetTree__label,
.facetTree__hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.facetTree__hint {
  font-size: 12px;
  color: var(--cs-mute);
}

.facetTree__track {
  height: 10px;
  overflow: hidden;
  border-radius: 2px;
  background: #ffffff0a;
}

.facetTree__track span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--cs-link);
  transition: width 0.25s;
}

.facetTree__count {
  font-size: 11px;
  text-align: right;
  color: var(--cs-dim);
}

.facetTree__row--picked .facetTree__pick {
  background: var(--cs-accent-soft);
}

.facetTree__row--picked .facetTree__track span {
  background: var(--cs-accent) !important;
}

.facetTree__row--partly .facetTree__pick {
  box-shadow: inset 0 0 0 1px #2f9e4499;
}

.facetTree__row--dimmed {
  opacity: 0.45;
}

.facetTree__more {
  align-self: flex-start;
  margin-top: 2px;
  padding: 0 4px;
  border: none;
  background: none;
  color: var(--cs-link);
  font-size: 11px;
  cursor: pointer;
}

.facetTree__empty {
  padding: 16px;
  text-align: center;
}

.facetTree__note {
  flex: none;
  margin: 8px 0 0;
  font-size: 11px;
}
</style>
