<!-- The matches, virtualized; the columns follow the list's own width, not the sheet's mode. -->
<template>
  <div ref="rootEl" class="catalogList">
    <div class="catalogList__row catalogList__row--head" :style="{ gridTemplateColumns: template }">
      <span />
      <span />
      <button
        v-for="column in columns"
        :key="column.id"
        type="button"
        class="catalogList__heading"
        :class="{ 'catalogList__cell--number': column.number }"
        @click="emit('sort', column.sort)"
      >
        {{ column.label }}
        <UIcon v-if="sortKey === column.sort" :name="sortDescending ? 'lucide:arrow-down' : 'lucide:arrow-up'" />
      </button>
      <span />
    </div>
    <div ref="scrollEl" class="catalogList__scroll cs-scroll">
      <div :style="{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }">
        <div
          v-for="item in visible"
          :key="item.row.satnum"
          class="catalogList__row"
          :class="{ 'catalogList__row--shown': active.has(item.row.name) }"
          :style="{ gridTemplateColumns: template, transform: `translateY(${item.start}px)` }"
        >
          <input type="checkbox" class="cs-check" :checked="active.has(item.row.name)" :aria-label="`Toggle ${item.row.name}`" @change="emit('toggle', item.row.name)" />
          <span class="catalogList__dot" :style="{ background: orbitColor(item.row.orbitClass, item.row.orbitKind) }" :title="orbitTitle(item.row)" />
          <span
            v-for="column in columns"
            :key="column.id"
            class="catalogList__cell"
            :class="{ 'catalogList__cell--number': column.number, 'cs-num': column.number, 'cs-dim': column.dim }"
            :title="column.title?.(item.row)"
            >{{ column.cell(item.row) }}</span
          >
          <button type="button" class="cs-iconBtn" :aria-label="`Show info for ${item.row.name}`" :title="`Show info for ${item.row.name}`" @click="emit('info', item.row.name)">
            <UIcon name="lucide:info" />
          </button>
        </div>
      </div>
      <div v-if="rows.length === 0" class="catalogList__empty cs-dim">No satellite matches these filters.</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import type { SortKey } from "../../composables/useCatalogFilters";
import { orbitColor, orbitKindLabel } from "../../config/orbitClass";
import type { CatalogRow } from "../../modules/catalogFacets";

const props = defineProps<{ rows: readonly CatalogRow[]; active: ReadonlySet<string>; sortKey: SortKey; sortDescending: boolean }>();
const emit = defineEmits<{ sort: [key: SortKey]; toggle: [name: string]; info: [name: string] }>();

/** Px, matching the row's CSS height. */
const ROW_HEIGHT = 26;

/** "LEO Sun-sync", "GEO Stationary", the class alone without a kind; a computed kind is starred. */
function orbitLabel(row: CatalogRow): string {
  if (row.orbitKind === undefined) return row.orbitClass;
  return `${row.orbitClass} ${orbitKindLabel(row.orbitClass, row.orbitKind)}${row.orbitKindComputed ? "*" : ""}`;
}

/** Says where a computed kind came from. */
function orbitTitle(row: CatalogRow): string {
  return row.orbitKindComputed && row.orbitKind !== undefined ? `${orbitLabel(row)}: worked out from the element set, as GCAT does not list it yet` : orbitLabel(row);
}

/** A list column: its heading, its track and its cells. */
interface Column {
  id: string;
  label: string;
  /** What a click on the heading sorts by. */
  sort: SortKey;
  /** The grid track. */
  track: string;
  number?: boolean;
  dim?: boolean;
  cell: (row: CatalogRow) => string;
  /** The cell's tooltip. */
  title?: (row: CatalogRow) => string;
}

/** Every column the list can show. */
const COLUMN: Record<"name" | "year" | "orbit" | "country" | "launched" | "altitude" | "inclination", Column> = {
  name: { id: "name", label: "Name", sort: "name", track: "minmax(110px, 1.6fr)", cell: (row) => row.name },
  year: { id: "year", label: "Year", sort: "launchDate", track: "44px", number: true, dim: true, cell: (row) => String(row.launchYear ?? "") },
  orbit: { id: "orbit", label: "Orbit", sort: "orbit", track: "minmax(90px, 1fr)", dim: true, cell: orbitLabel, title: orbitTitle },
  country: { id: "country", label: "Country", sort: "country", track: "minmax(60px, 0.7fr)", cell: (row) => row.country },
  launched: { id: "launched", label: "Launched", sort: "launchDate", track: "80px", number: true, cell: (row) => row.launchDate ?? "—" },
  altitude: { id: "altitude", label: "Alt km", sort: "altitudeKm", track: "56px", number: true, cell: (row) => Math.round(row.altitudeKm).toLocaleString() },
  inclination: { id: "inclination", label: "Inc °", sort: "inclinationDeg", track: "44px", number: true, cell: (row) => row.inclinationDeg.toFixed(1) },
};

/** Px of list width each column set needs, widest first. */
const COLUMN_SETS: [number, Column[]][] = [
  [580, [COLUMN.name, COLUMN.orbit, COLUMN.country, COLUMN.launched, COLUMN.altitude, COLUMN.inclination]],
  [450, [COLUMN.name, COLUMN.orbit, COLUMN.launched, COLUMN.altitude]],
  [0, [COLUMN.name, COLUMN.year]],
];

// The list's own width, which picks the column set.
const rootEl = ref<HTMLElement | null>(null);
const width = ref(340);
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry) width.value = entry.contentRect.width;
  });
  if (rootEl.value) observer.observe(rootEl.value);
});
onBeforeUnmount(() => observer?.disconnect());

/** The widest column set that fits. */
const columns = computed<Column[]>(() => COLUMN_SETS.find(([min]) => width.value >= min)?.[1] ?? [COLUMN.name]);
/** The grid tracks: checkbox, dot, the columns, info. */
const template = computed(() => `18px 8px ${columns.value.map((column) => column.track).join(" ")} 26px`);

// The virtualizer over the scrolling list.
const scrollEl = ref<HTMLElement | null>(null);
const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.rows.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })),
);
/** Drops any item whose row vanished mid-recompute, so the template stays index-safe. */
const visible = computed(() =>
  virtualizer.value
    .getVirtualItems()
    .map((item) => ({ start: item.start, row: props.rows[item.index] }))
    .filter((item): item is { start: number; row: CatalogRow } => item.row !== undefined),
);
</script>

<style scoped>
.catalogList {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.catalogList__row {
  display: grid;
  align-items: center;
  gap: 8px;
  height: 26px;
  padding: 0 6px 0 10px;
  white-space: nowrap;
}

.catalogList__scroll {
  flex: 1;
  min-height: 0;
}

.catalogList__scroll .catalogList__row {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
}

.catalogList__scroll .catalogList__row:hover {
  background: var(--cs-raised);
}

.catalogList__row--shown {
  background: #2f9e4414;
}

.catalogList__row--head {
  flex: none;
  border-top: 1px solid var(--cs-line);
  border-bottom: 1px solid var(--cs-line);
  font-size: 10px;
  color: var(--cs-dim);
}

.catalogList__heading {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: pointer;
}

.catalogList__cell {
  overflow: hidden;
  text-overflow: ellipsis;
}

.catalogList__cell--number {
  justify-content: flex-end;
  text-align: right;
}

.catalogList__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.catalogList__empty {
  padding: 40px 12px;
  text-align: center;
}
</style>
