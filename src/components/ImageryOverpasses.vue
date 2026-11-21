<template>
  <section class="overpasses">
    <div class="overpasses__title">Imagery overpasses · last {{ STATION_DAYS }} days</div>
    <div v-if="layers.length === 0" class="overpasses__empty">
      <template v-if="loadingCatalog">Looking for satellites with per-granule imagery…</template>
      <template v-else>
        No satellite with per-granule imagery is loaded.
        <a class="link" @click="loadCatalog">Look in every group</a>
      </template>
    </div>
    <div v-else-if="pending" class="overpasses__empty">Asking NASA CMR…</div>
    <div v-else-if="failed && rows.length === 0" class="overpasses__empty">NASA CMR did not answer</div>
    <div v-else-if="rows.length === 0" class="overpasses__empty">No overpass by day in the last {{ STATION_DAYS }} days</div>
    <table v-else class="overpasses__table">
      <thead>
        <tr>
          <th v-if="layers.length > 1">Satellite</th>
          <th>Start (UTC)</th>
          <th>Imagery</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key" :title="`Replay ${row.satellite} over ${stationName}`" @click="replayRow(row)">
          <td v-if="layers.length > 1">{{ row.satellite }}</td>
          <td class="mono">{{ row.startLabel }}</td>
          <td>
            <span class="overpasses__pixels" :class="`overpasses__pixels--${pixels.get(row.key) ?? 'asking'}`">{{ PIXEL_LABELS[pixels.get(row.key) ?? "asking"] }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { storeToRefs } from "pinia";
import { computed, reactive, ref, watch } from "vue";

import { useController } from "@/composables/useController";
import { useOverpassReplay } from "@/composables/useOverpassReplay";
import { type GranuleLayer, isGranuleLayer, readImageryList } from "@/config/instrumentImagery";
import { hasPixels, STATION_DAYS, stationOverpasses, stationReplay } from "@/modules/overpassReplay";
import type { Overpass } from "@/modules/util/cmrGranules";
import { useSatStore } from "@/stores/sat";

dayjs.extend(utc);

/**
 * A station's overpasses by day that a granule layer has (ADR 0023), newest first, each a
 * replay of it: from CMR's granules over the station, for every loaded satellite with such a
 * layer, whether or not it is on.
 */
const props = defineProps<{
  latitude: number;
  longitude: number;
  stationName: string;
}>();

const { sats } = useController();
const { catalogRevision } = storeToRefs(useSatStore());
const replay = useOverpassReplay();

/** Each loaded satellite's granule layers. */
const layers = computed(() => {
  void catalogRevision.value;
  const found = new Map<string, { satellite: string; layer: GranuleLayer }>();
  for (const entry of sats.catalog.entries) {
    for (const { drawn } of readImageryList(entry.metadata.imagery)) {
      if (isGranuleLayer(drawn) && !found.has(`${entry.satnum}:${drawn.token}`)) {
        found.set(`${entry.satnum}:${drawn.token}`, { satellite: entry.name, layer: drawn });
      }
    }
  }
  return [...found.values()];
});

const loadingCatalog = ref(false);
function loadCatalog(): void {
  loadingCatalog.value = true;
  void sats.catalog.ensureAll().finally(() => (loadingCatalog.value = false));
}

interface Row {
  key: string;
  satellite: string;
  layer: GranuleLayer;
  overpass: Overpass;
  startLabel: string;
}

const rows = ref<Row[]>([]);
const pending = ref(false);
const failed = ref(false);

type Pixels = "asking" | "all" | "some" | "none";
const PIXEL_LABELS: Record<Pixels, string> = { asking: "…", all: "Image", some: "Part image", none: "Outline only" };
/** Whether GIBS has the pixels of a row's granules, by row. */
const pixels = reactive(new Map<string, Pixels>());

/** The catalog changes with every group that loads; the overpasses only when its granule layers do. */
const layersKey = computed(() => layers.value.map(({ satellite, layer }) => `${satellite}:${layer.token}`).join("|"));

watch(
  [layersKey, () => props.latitude, () => props.longitude],
  ([, latitude, longitude], _, onCleanup) => {
    const found = layers.value;
    const asking = new AbortController();
    onCleanup(() => asking.abort());
    rows.value = [];
    pixels.clear();
    failed.value = false;
    if (found.length === 0) return;
    pending.value = true;
    void Promise.all(
      found.map(async ({ satellite, layer }) => {
        const overpasses = await stationOverpasses(layer, { latitude, longitude }, asking.signal);
        if (overpasses === undefined) failed.value = true;
        return (overpasses ?? []).map((overpass): Row => ({
          key: `${satellite}:${overpass.start}`,
          satellite,
          layer,
          overpass,
          startLabel: dayjs.utc(overpass.start).format("MM-DD HH:mm"),
        }));
      }),
    ).then((lists) => {
      if (asking.signal.aborted) return;
      pending.value = false;
      rows.value = lists.flat().toSorted((a, b) => b.overpass.start - a.overpass.start);
      for (const row of rows.value) {
        void Promise.all(row.overpass.granules.map((granule) => hasPixels(row.layer, granule))).then((answers) => {
          if (asking.signal.aborted) return;
          const count = answers.filter(Boolean).length;
          pixels.set(row.key, count === answers.length ? "all" : count > 0 ? "some" : "none");
        });
      }
    });
  },
  { immediate: true },
);

function replayRow(row: Row): void {
  replay(row.layer, row.satellite, stationReplay(row.overpass, { latitude: props.latitude, longitude: props.longitude }));
}
</script>

<style scoped>
/* The info panel's section heading. */
.overpasses__title {
  margin: 0 0 5px;
  color: var(--panel-muted);
  font-size: var(--text-section);
  font-weight: 600;
  line-height: 16px;
}

.overpasses__empty {
  color: var(--panel-muted);
  font-size: 12.5px;
}

.overpasses__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.overpasses__table th,
.overpasses__table td {
  padding: 3px 6px;
  text-align: left;
}

.overpasses__table thead th {
  color: #edffffb0;
  font-size: var(--text-section);
  font-weight: 600;
}

.overpasses__table tbody tr {
  cursor: pointer;
}

.overpasses__table tbody tr:nth-child(odd) {
  background: #ffffff08;
}

.overpasses__table tbody tr:hover {
  background: #edffff1f;
}

.overpasses__pixels--none,
.overpasses__pixels--asking {
  color: var(--panel-muted);
}

.overpasses__pixels--some {
  color: var(--panel-amber);
}

.mono {
  font-variant-numeric: tabular-nums;
}

.link {
  cursor: pointer;
  text-decoration: underline;
}
</style>
