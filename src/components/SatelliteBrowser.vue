<template>
  <div class="satellite-browser">
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
          <satellite-browser-row :row="virtualRow.row" :stacked="isPhone" @toggle-group="toggleGroup" @toggle-sat="toggleSat" @show-info="showInfo" @toggle-expand="toggleExpand" />
        </div>
      </div>
    </div>
    <!-- A search loads every group, and the biggest takes seconds. -->
    <div v-else-if="loadingAll" class="browser-empty">Loading all satellites…</div>
    <div v-else class="browser-empty">No matches</div>

    <div class="browser-summary">
      <span
        >{{ formatInteger(groupCount) }} group{{ groupCount === 1 ? "" : "s" }} · {{ formatInteger(activeSatCount) }} satellite{{ activeSatCount === 1 ? "" : "s" }} active</span
      >
      <button v-if="hasActiveSelection" type="button" class="browser-clear" @click="clearAll">Clear all</button>
    </div>
    <button type="button" class="browser-catalog" @click="emit('browse')"><UIcon name="lucide:chart-no-axes-column" /> Browse and filter the catalog</button>
  </div>
</template>

<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, onBeforeUnmount, ref } from "vue";

import { useController } from "@/composables/useController";
import { type BrowserRow, useSatelliteBrowser } from "@/composables/useSatelliteBrowser";
import { useSelectedEntity } from "@/composables/useSelectedEntity";
import { PHONE_WIDTH } from "@/config/layout";
import { formatInteger } from "@/modules/util/formats";

const ROW_HEIGHT = 28;
/** A search result on a phone: its tags on a second line, so neither cuts the name short. */
const STACKED_ROW_HEIGHT = 42;

/** Guarded: jsdom leaves `matchMedia` undefined. */
const phoneQuery = globalThis.matchMedia?.(`(max-width: ${PHONE_WIDTH - 1}px)`);
const isPhone = ref(phoneQuery?.matches ?? false);
const onPhoneChange = (event: MediaQueryListEvent): void => {
  isPhone.value = event.matches;
};
phoneQuery?.addEventListener("change", onPhoneChange);
onBeforeUnmount(() => phoneQuery?.removeEventListener("change", onPhoneChange));

const controller = useController();
const { sats } = controller;
const { showSatellite } = useSelectedEntity(controller);

const { searchQuery, loadingAll, setSearchQuery, clearSearch, rows, activeSatCount, groupCount, hasActiveSelection, isLoading, toggleGroup, toggleSat, toggleExpand, clearAll } =
  useSatelliteBrowser(sats.catalog);

const emit = defineEmits<{ "show-info": [name: string]; browse: [] }>();

function showInfo(name: string): void {
  showSatellite(name);
  emit("show-info", name);
}

/** A row's height in px: a search result's on a phone, with its tags under its name, is taller. */
function rowHeight(row: BrowserRow | undefined, stacked: boolean): number {
  return stacked && row?.kind === "sat" && row.groupsLabel ? STACKED_ROW_HEIGHT : ROW_HEIGHT;
}

const listHeight = computed(() => `min(${rows.value.reduce((sum, row) => sum + rowHeight(row, isPhone.value), 0)}px, 60dvh)`);

const scrollEl = ref<HTMLElement | null>(null);
const virtualizer = useVirtualizer(
  computed(() => {
    const list = rows.value;
    const stacked = isPhone.value;
    return {
      count: list.length,
      getScrollElement: () => scrollEl.value,
      estimateSize: (index: number) => rowHeight(list[index], stacked),
      // The virtualizer lays out again when `getItemKey` changes, never `estimateSize`, so a
      // new one with each list or width keeps the offsets in step with the heights.
      getItemKey: (index: number) => list[index]?.id ?? index,
      overscan: 8,
    };
  }),
);

/** Drops any item whose row vanished mid-recompute, so the template stays index-safe. */
const virtualRows = computed(() =>
  virtualizer.value
    .getVirtualItems()
    .map((virtualRow) => ({ start: virtualRow.start, row: rows.value[virtualRow.index] }))
    .filter((item): item is { start: number; row: BrowserRow } => item.row !== undefined),
);
const totalSize = computed(() => virtualizer.value.getTotalSize());

// Mounted behind a `v-if` in Satvis.vue, so the first measurement is not 0x0.
</script>

<style scoped>
.satellite-browser {
  display: flex;
  flex-direction: column;
  width: min(320px, var(--toolbar-panel-max));
  max-height: calc(100dvh - 120px);
  gap: 6px;
  padding: 0 6px 6px;
  box-sizing: border-box;
}

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
  color: var(--panel-ink);
}

.browser-list {
  /* The column has no definite height, so the list would collapse under flex-grow. */
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
  color: var(--panel-destructive);
  font-size: 12px;
}

.browser-catalog {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: none;
  color: var(--panel-ink);
  font-size: 12px;
  cursor: pointer;
}

.browser-catalog:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.browser-clear:hover {
  background-color: rgba(255, 255, 255, 0.1);
}
</style>
