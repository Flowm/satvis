<template>
  <div ref="galleryEl" class="gallery">
    <article
      v-for="{ instrument, imagery } in layers"
      :key="imagery.key"
      class="card"
      :class="{ 'card--drawable': imagery.token, 'card--shown': isShown(imagery) }"
      :data-instrument="instrument"
      :aria-label="`${instrument} ${imagery.label}`"
      @click="toggle(imagery)"
    >
      <div class="card__preview">
        <img v-if="previews.get(imagery.key) && !failed.has(imagery.key)" :src="previews.get(imagery.key)" alt="" loading="lazy" @error="failed.add(imagery.key)" />
        <div v-else class="card__placeholder">
          <template v-if="imagery.replay?.provider === 'cmr'">
            <UIcon name="lucide:square-dashed" />
            <span>Outlines only</span>
          </template>
          <template v-else>
            <UIcon name="lucide:image-off" />
            <span>No preview</span>
          </template>
        </div>
        <span class="card__badge">{{ instrument }}</span>
        <span v-if="imagery.preview?.end" class="card__badge card__badge--ended">Ended {{ imagery.preview.end }}</span>
        <button
          v-if="imagery.replay && latest.get(imagery.key)"
          type="button"
          class="card__replay"
          :title="`Replay the overpass of ${granuleTime(latest.get(imagery.key)!)}, with its granules on the globe`"
          @click.stop="replayLatest(imagery)"
        >
          <UIcon name="lucide:history" />
          Replay {{ granuleTime(latest.get(imagery.key)!) }}
        </button>
      </div>
      <div class="card__body">
        <div class="card__title">{{ imagery.label }}</div>
        <div v-if="imagery.detail" class="card__detail">{{ imagery.detail }}</div>
        <div class="card__actions">
          <USwitch
            v-if="imagery.token"
            :model-value="isShown(imagery)"
            label="Show"
            size="sm"
            :aria-label="`Show ${imagery.label} as a map layer`"
            @update:model-value="cesiumStore.toggleInstrumentImagery(imagery.token, $event)"
            @click.stop
          />
          <span v-else />
          <a v-if="imagery.href" class="card__open" :href="imagery.href" :title="`Open in ${imagery.viewer}`" target="_blank" rel="noopener" @click.stop>
            {{ imagery.viewer }}
            <UIcon name="lucide:external-link" />
          </a>
        </div>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { computed, nextTick, onMounted, onUnmounted, reactive, useTemplateRef, watch } from "vue";

import { useOverpassReplay } from "@/composables/useOverpassReplay";
import { imageryPreviewUrl, isGranuleLayer, PREVIEW_HEIGHT, PREVIEW_WIDTH, type PreviewCentre, previewBounds } from "@/config/instrumentImagery";
import { geoMosaicPreview } from "@/modules/GeoMosaicImagery";
import { granuleCentre, latestGranule, latestReplay } from "@/modules/overpassReplay";
import type { Granule } from "@/modules/util/cmrGranules";
import type { ImageryInfo } from "@/modules/util/entityInfo";
import { formatFrame } from "@/modules/util/timeDomain";
import { useCesiumStore } from "@/stores/cesium";

/**
 * The Imagery tab: a card for each layer that shows one of the satellite's instruments,
 * with a picture of its latest frame, a switch that shows it on the globe where the globe
 * can draw it, and a link to it in its provider's viewer.
 */
const props = defineProps<{
  layers: { instrument: string; imagery: ImageryInfo }[];
  centre: PreviewCentre | undefined;
  geostationary: boolean;
  /** The instrument whose first card is scrolled into view. */
  focus: string | undefined;
  /** The satellite's name, which a replay turns on. */
  satellite: string;
}>();

const cesiumStore = useCesiumStore();
/** Previews that could not be had, by card, which show the placeholder instead; forgotten with the satellite. */
const failed = reactive(new Set<string>());

/**
 * Where the pictures are, built once per satellite. A geostationary imager sees a disc
 * about 80° either side; a low one is pictured where it flies.
 */
const bounds = computed(() => (props.centre ? previewBounds(props.centre, props.geostationary ? 72 : 32) : undefined));

/** The georing mosaic has no WMS: its picture is made here from its file. */
const isGeoring = (imagery: ImageryInfo) => imagery.preview?.provider === "georing";

/** The pictures made here, by card: object urls. */
const madePreviews = reactive(new Map<string, string>());
/** Revokes the pictures made here, and lets every card try again. */
function forgetPreviews(): void {
  madePreviews.forEach((url) => URL.revokeObjectURL(url));
  madePreviews.clear();
  failed.clear();
}
watch(
  [() => props.layers, bounds],
  ([layers, where], _, onCleanup) => {
    forgetPreviews();
    const reading = new AbortController();
    onCleanup(() => reading.abort());
    if (where === undefined) return;
    for (const { imagery } of layers.filter((layer) => isGeoring(layer.imagery))) {
      geoMosaicPreview(where, PREVIEW_WIDTH, PREVIEW_HEIGHT, reading.signal)
        .then((blob) => {
          if (!reading.signal.aborted) madePreviews.set(imagery.key, URL.createObjectURL(blob));
        })
        .catch((error: unknown) => {
          if (!reading.signal.aborted) {
            console.warn("[ImageryGallery]", error);
            failed.add(imagery.key);
          }
        });
    }
  },
  { immediate: true },
);
onUnmounted(forgetPreviews);

/**
 * A granule layer's newest day granule with pixels, by card, which it pictures and replays:
 * its latest frame is a granule that may be by night, or one GIBS left out.
 */
const latest = reactive(new Map<string, Granule>());
watch(
  () => props.layers,
  (layers, _, onCleanup) => {
    latest.clear();
    const reading = new AbortController();
    onCleanup(() => reading.abort());
    for (const { imagery } of layers) {
      const layer = imagery.replay;
      if (!isGranuleLayer(layer)) continue;
      void latestGranule(layer, reading.signal).then((granule) => {
        if (granule !== undefined && !reading.signal.aborted) latest.set(imagery.key, granule);
      });
    }
  },
  { immediate: true },
);

dayjs.extend(utc);

/** "11-20 11:42 UTC". */
function granuleTime(granule: Granule): string {
  return `${dayjs.utc(granule.start).format("MM-DD HH:mm")} UTC`;
}

/** Degrees either side of a granule's centre in its picture: a NOAA-20 granule is about 3,000 km across. */
const GRANULE_HALF_WIDTH = 20;

const replay = useOverpassReplay();
function replayLatest(imagery: ImageryInfo): void {
  const granule = latest.get(imagery.key);
  if (granule !== undefined && isGranuleLayer(imagery.replay)) {
    replay(imagery.replay, props.satellite, latestReplay(granule));
  }
}

/** Each card's picture by card: a provider's WMS answer, or one made here. */
const previews = computed(() => {
  const where = bounds.value;
  const now = new Date();
  return new Map(
    props.layers.flatMap(({ imagery }) => {
      const granule = latest.get(imagery.key);
      if (imagery.preview && granule !== undefined) {
        const at = formatFrame(granule.start, false);
        // Held off the antimeridian, where GIBS's WMS draws nothing for a box that crosses it.
        const { latitude, longitude } = granuleCentre(granule);
        const centre = { latitude, longitude: Math.max(-180 + GRANULE_HALF_WIDTH, Math.min(180 - GRANULE_HALF_WIDTH, longitude)) };
        return [[imagery.key, imageryPreviewUrl({ ...imagery.preview, at }, previewBounds(centre, GRANULE_HALF_WIDTH), now)] as const];
      }
      if (!imagery.preview || where === undefined || imagery.replay) return [];
      const url = isGeoring(imagery) ? madePreviews.get(imagery.key) : imageryPreviewUrl(imagery.preview, where, now);
      return url === undefined ? [] : [[imagery.key, url] as const];
    }),
  );
});

/** A press anywhere on a card the globe can draw shows it or takes it off; its switch is the keyboard's way. */
function toggle(imagery: ImageryInfo): void {
  if (imagery.token !== undefined) {
    cesiumStore.toggleInstrumentImagery(imagery.token, !isShown(imagery));
  }
}

function isShown(imagery: ImageryInfo): boolean {
  return imagery.token !== undefined && cesiumStore.instrumentImagery.includes(imagery.token);
}

const galleryEl = useTemplateRef<HTMLElement>("galleryEl");

function reveal(): void {
  if (props.focus === undefined) {
    return;
  }
  // Wait for the cards, which mount with the tab.
  nextTick(() => galleryEl.value?.querySelector(`[data-instrument="${CSS.escape(props.focus!)}"]`)?.scrollIntoView({ block: "nearest" }));
}

onMounted(reveal);
watch(() => props.focus, reveal);
</script>

<style scoped>
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.card {
  overflow: hidden;
  border: 1px solid var(--panel-hairline);
  border-radius: 8px;
  background: var(--panel-raised);
}

.card--drawable {
  cursor: pointer;
}

.card--drawable:hover {
  border-color: var(--panel-faint);
}

.card--shown,
.card--shown:hover {
  border-color: var(--panel-accent);
  box-shadow: 0 0 0 1px var(--panel-accent);
}

.card__preview {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #0b0d10;
}

.card__preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.card__placeholder {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--panel-faint);
  font-size: 11px;
}

.card__badge {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #000000b0;
  font-size: 11px;
  font-weight: 600;
}

.card__replay {
  position: absolute;
  right: 6px;
  bottom: 6px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #000000c0;
  color: var(--panel-ink);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.card__replay:hover {
  background: var(--panel-accent);
  color: #000;
}

/* Amber: the app colour for "away from rest", as on the status chip. */
.card__badge--ended {
  right: 6px;
  left: auto;
  color: var(--panel-amber);
}

.card__body {
  padding: 8px 10px 10px;
}

.card__title {
  font-size: 13.5px;
  font-weight: 600;
}

.card__detail {
  color: var(--panel-muted);
  font-size: 11.5px;
}

.card__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
}

.card__open {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--panel-muted);
}

.card__open:hover {
  color: var(--panel-ink);
}
</style>
