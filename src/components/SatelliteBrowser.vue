<template>
  <div class="satellite-browser">
    <!-- Bound to enabledTags by the tag value-key, so one click takes a whole group. -->
    <div class="toolbarTitle">Satellite groups</div>
    <div class="browser-quickselect">
      <USelectMenu
        :model-value="enabledTags"
        @update:model-value="setEnabledTags"
        :items="groupItems"
        value-key="value"
        label-key="label"
        multiple
        :search-input="{ placeholder: 'Filter groups' }"
        placeholder="Select groups"
        class="w-full"
      />
    </div>

    <div class="browser-search">
      <UInput
        :model-value="searchQuery"
        placeholder="Search satellites"
        icon="i-lucide-search"
        :ui="{ base: 'w-full' }"
        class="w-full"
        @update:model-value="setSearchQuery(String($event))"
      >
        <template v-if="searchQuery" #trailing>
          <button type="button" class="browser-search-clear" aria-label="Clear search" @click="clearSearch">
            <UIcon name="lucide:x" />
          </button>
        </template>
      </UInput>
    </div>

    <!-- Virtualized, and the only element here that scrolls. -->
    <div v-if="isLoading" class="browser-empty">Loading satellites…</div>
    <div v-else-if="rows.length > 0" ref="scrollEl" class="browser-list" :style="{ height: listHeight }">
      <div class="browser-list-inner" :style="{ height: `${totalSize}px` }">
        <div v-for="virtualRow in virtualRows" :key="virtualRow.row.id" class="browser-list-row" :style="{ transform: `translateY(${virtualRow.start}px)` }">
          <satellite-browser-row :row="virtualRow.row" @toggle-group="toggleGroup" @toggle-sat="toggleSat" @show-info="showInfo" @toggle-expand="toggleExpand" />
        </div>
      </div>
    </div>
    <!-- A search loads every group, and the biggest takes seconds. -->
    <div v-else-if="searchLoading" class="browser-empty">Loading all satellites…</div>
    <div v-else class="browser-empty">No matches</div>

    <div class="browser-summary">
      <span>{{ groupCount }} group{{ groupCount === 1 ? "" : "s" }} · {{ activeSatCount }} satellite{{ activeSatCount === 1 ? "" : "s" }} active</span>
      <button v-if="hasActiveSelection" type="button" class="browser-clear" @click="clearAll">Clear all</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, ref } from "vue";

import { useController } from "../composables/useController";
import { type BrowserRow, useSatelliteBrowser } from "../composables/useSatelliteBrowser";

const ROW_HEIGHT = 28;

const { sats } = useController();

const {
  searchQuery,
  searchLoading,
  setSearchQuery,
  clearSearch,
  availableGroups,
  enabledTags,
  setEnabledTags,
  rows,
  activeSatCount,
  groupCount,
  hasActiveSelection,
  isLoading,
  toggleGroup,
  toggleSat,
  activateSat,
  toggleExpand,
  clearAll,
} = useSatelliteBrowser(sats.catalog);

function showInfo(name: string): void {
  activateSat(name);
  sats.select(name);
}

const groupItems = computed(() => availableGroups.value.toSorted((a, b) => a.tag.localeCompare(b.tag)).map((g) => ({ label: `${g.tag} (${g.count})`, value: g.tag })));

// Surfaces come from Nuxt UI's dark palette (`dark` class on #app) with the
// neutral-gray alias set in vite.config.ts, so no per-component color
// overrides are needed here.

// Scroll container height: min(rows * ROW_HEIGHT, 60dvh) so short lists hug
// their content and long ones cap out and scroll internally.
const listHeight = computed(() => `min(${rows.value.length * ROW_HEIGHT}px, 60dvh)`);

const scrollEl = ref<HTMLElement | null>(null);
const virtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })),
);

// Pair each virtual item with its row up front. The virtualizer only emits
// indices within `count`, but pairing here lets the template stay index-safe
// (and drops any stray item whose row vanished mid-recompute).
const virtualRows = computed(() =>
  virtualizer.value
    .getVirtualItems()
    .map((virtualRow) => ({ start: virtualRow.start, row: rows.value[virtualRow.index] }))
    .filter((item): item is { start: number; row: BrowserRow } => item.row !== undefined),
);
const totalSize = computed(() => virtualizer.value.getTotalSize());

// Mount/visibility note: this component sits behind a `v-if` in Satvis.vue
// (not v-show like the sibling panels), so the scroll element is always laid
// out with its real size when the virtualizer first measures it. Under v-show
// the initial measurement would read 0x0 from inside the hidden panel and the
// list would stay blank until a ResizeObserver tick. TanStack's own observers
// handle scroll and resize from here on; the composable's module-scoped state
// (search, expansion) survives the remounts v-if causes.
</script>

<style scoped>
.satellite-browser {
  display: flex;
  flex-direction: column;
  width: min(320px, calc(100vw - 12px));
  max-height: calc(100dvh - 120px);
  gap: 6px;
  padding: 0 6px 6px;
  box-sizing: border-box;
}

.browser-quickselect,
.browser-search {
  flex: 0 0 auto;
}

.browser-search-clear {
  background: none;
  border: none;
  padding: 0 2px;
  cursor: pointer;
  color: #b8c4c4;
  display: inline-flex;
  align-items: center;
}

.browser-search-clear:hover {
  color: #edffff;
}

.browser-list {
  /* Explicit height (min(rows*28px, 60dvh)) drives the size; the panel column
     has no definite height, so `flex: 0 0 auto` keeps the list from collapsing
     (flex-grow needs free space that a content-sized column doesn't provide). */
  flex: 0 0 auto;
  position: relative;
  overflow-y: auto;
  overflow-x: hidden;
  border-radius: 6px;
  background-color: #00000033;
}

.browser-list-inner {
  position: relative;
  width: 100%;
}

.browser-list-row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}

.browser-empty {
  flex: 0 0 auto;
  padding: 12px 6px;
  text-align: center;
  font-size: 13px;
  color: #b8c4c4;
}

.browser-summary {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: #b8c4c4;
  padding: 2px 4px 0;
}

.browser-clear {
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  color: #edffff;
  font-size: 12px;
}

.browser-clear:hover {
  background-color: rgba(255, 255, 255, 0.1);
}
</style>
