<!-- Adds custom satellites from pasted element sets, and lists those this browser keeps. -->
<template>
  <UModal
    v-model:open="open"
    title="Custom satellites"
    description="Paste a TLE, with or without its name line, or an OMM as JSON, CSV, XML or KVN. Several at once are fine."
    :ui="{
      content: 'catalogCustom bg-(--panel-surface-dense) text-(--panel-ink) divide-neutral-600 max-w-2xl',
      header: 'p-2 sm:px-3',
      body: 'p-3 sm:p-3',
      description: 'text-(--cs-dim) text-xs',
    }"
  >
    <template #body>
      <div class="catalogCustom__input">
        <textarea v-model="text" class="catalogCustom__text cs-scroll" rows="7" spellcheck="false" autocomplete="off" aria-label="Element sets" :placeholder="PLACEHOLDER" />
        <div class="catalogCustom__row">
          <label class="cs-btn catalogCustom__file">
            <UIcon name="lucide:file-up" /> Open a file
            <input type="file" accept=".txt,.tle,.3le,.json,.csv,.xml,.kvn,text/*,application/json" @change="readFile" />
          </label>
          <span class="catalogCustom__spacer" />
          <span v-if="loading" class="cs-mute">Loading the catalog…</span>
          <button type="button" class="cs-btn cs-btn--primary" :disabled="loading || parsed.records.length === 0" @click="add"><UIcon name="lucide:plus" /> {{ addLabel }}</button>
        </div>
      </div>

      <ul v-if="parsed.problems.length" class="catalogCustom__problems" aria-live="polite">
        <li v-for="problem in parsed.problems" :key="problem"><UIcon name="lucide:triangle-alert" /> {{ problem }}</li>
      </ul>
      <template v-for="list in lists" :key="list.label">
        <h3 v-if="list.removable" class="catalogCustom__heading">In this browser</h3>
        <ul class="catalogCustom__list" :aria-label="list.label">
          <li v-for="row in list.rows.slice(0, SHOW_CAP)" :key="row.name">
            <span class="catalogCustom__dot" :style="{ background: row.color }" :title="row.orbitClass" />
            <span class="catalogCustom__name">{{ row.name }}</span>
            <span class="cs-dim cs-num">{{ row.satnum }}</span>
            <span class="cs-mute">{{ row.orbitClass }} · epoch {{ row.epoch }}</span>
            <span v-if="!list.removable && storedNames.has(row.name)" class="cs-chip">replaces</span>
            <template v-if="list.removable">
              <span class="catalogCustom__spacer" />
              <button type="button" class="cs-iconBtn" :aria-label="`Remove ${row.name}`" :title="`Remove ${row.name}`" @click="customStore.remove(row.name)">
                <UIcon name="lucide:trash-2" />
              </button>
            </template>
          </li>
        </ul>
        <p v-if="list.rows.length > SHOW_CAP" class="cs-mute">
          And {{ (list.rows.length - SHOW_CAP).toLocaleString() }} more.<template v-if="!list.removable"> All join the catalog; the globe shows the first {{ SHOW_CAP }}.</template>
        </p>
      </template>
      <p class="catalogCustom__note cs-mute">Kept in this browser only.</p>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, ref } from "vue";

import { SHOW_CAP } from "../../composables/useCatalogFilters";
import { useController } from "../../composables/useController";
import { type OrbitClass, orbitColor } from "../../config/orbitClass";
import { isCustom, parseCustomElements } from "../../modules/customSatellites";
import { computedOrbitKindOf, epochMsOf, type GpRecord, orbitClassOf, recordName, recordSatnum } from "../../modules/util/gp";
import { useCustomSatelliteStore } from "../../stores/customSatellites";
import { useSatStore } from "../../stores/sat";

defineProps<{ loading: boolean }>();
const emit = defineEmits<{ added: [names: string[]] }>();
const open = defineModel<boolean>("open", { required: true });

/** A 3LE, to show the shape of one. */
const PLACEHOLDER = `MY SATELLITE
1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992
2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658`;

const { sats } = useController();
const satStore = useSatStore();
const customStore = useCustomSatelliteStore();
const { catalogRevision } = storeToRefs(satStore);

/** What is pasted or read from a file. */
const text = ref("");

/** Whether a catalog satellite has the name, which a custom one may not take. */
function isTaken(name: string): boolean {
  // The catalog is not reactive; the revision makes `parsed` check again as groups load.
  void catalogRevision.value;
  const entry = sats.catalog.getByName(name);
  return entry !== undefined && !isCustom(entry);
}

/** The usable element sets in the text, and why the rest were dropped. */
const parsed = computed(() => parseCustomElements(text.value, isTaken));

/** A satellite as the dialog lists it. */
interface CustomRow {
  /** Unique within each list. */
  name: string;
  /** The NORAD id. */
  satnum: string;
  orbitClass: OrbitClass;
  /** The catalog list's colour for its orbit. */
  color: string;
  /** UTC, to the minute. */
  epoch: string;
}

/** A record as the dialog lists it. */
function customRowOf(record: GpRecord): CustomRow {
  const epochMs = epochMsOf(record);
  const orbitClass = record.metadata?.orbitClass ?? orbitClassOf(record);
  return {
    name: recordName(record),
    satnum: recordSatnum(record),
    orbitClass,
    color: orbitColor(orbitClass, computedOrbitKindOf(record, orbitClass)),
    epoch: Number.isFinite(epochMs) ? new Date(epochMs).toISOString().slice(0, 16).replace("T", " ") : "unknown",
  };
}

/** The names this browser keeps, which an added satellite of the same name replaces. */
const storedNames = computed(() => new Set(customStore.records.map(recordName)));
/** What Add would add, then what this browser keeps, each shown when it has any. */
const lists = computed(() =>
  [
    { label: "Ready to add", rows: parsed.value.records.map(customRowOf), removable: false },
    { label: "Custom satellites in this browser", rows: customStore.records.map(customRowOf), removable: true },
  ].filter((list) => list.rows.length > 0),
);

/** The Add button's label, with the count when there are several. */
const addLabel = computed(() => {
  const count = parsed.value.records.length;
  return count > 1 ? `Add ${count.toLocaleString()} to the globe` : "Add to the globe";
});

/** Into the catalog, and onto the globe by name, as every activation writer does. */
function add(): void {
  const names = parsed.value.records.map(recordName);
  customStore.add(parsed.value.records);
  satStore.setActivation({ enabledSatellites: [...satStore.enabledSatellites, ...names.slice(0, SHOW_CAP)] });
  text.value = "";
  open.value = false;
  emit("added", names);
}

/** Puts the picked file's text in the box. */
async function readFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    text.value = await file.text();
  }
  // So the same file can be picked again.
  input.value = "";
}
</script>

<style scoped>
.catalogCustom__input {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.catalogCustom__text {
  width: 100%;
  min-height: 120px;
  padding: 8px;
  border: 1px solid var(--cs-line);
  border-radius: 6px;
  background: var(--cs-raised);
  color: var(--cs-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre;
  resize: vertical;
}

.catalogCustom__text:focus {
  border-color: var(--cs-accent);
  outline: none;
}

.catalogCustom__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.catalogCustom__spacer {
  flex: 1;
}

.catalogCustom__file {
  position: relative;
  overflow: hidden;
}

.catalogCustom__file input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.catalogCustom__problems {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  color: #ffc078;
  font-size: 12px;
}

.catalogCustom__problems li {
  display: flex;
  align-items: center;
  gap: 6px;
}

.catalogCustom__heading {
  margin: 14px 0 0;
  color: var(--cs-dim);
  font-size: 12px;
  font-weight: 600;
}

.catalogCustom__list {
  max-height: 180px;
  margin: 8px 0 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.catalogCustom__list li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  border-bottom: 1px solid var(--cs-line);
}

.catalogCustom__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.catalogCustom__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catalogCustom__note {
  margin: 12px 0 0;
  font-size: 12px;
}
</style>
