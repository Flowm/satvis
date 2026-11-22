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
        <img
          v-if="previews.get(imagery.key) && !failed.has(imagery.key)"
          :key="`${imagery.key}#${previewErrors.get(imagery.key) ?? 0}`"
          :src="previews.get(imagery.key)"
          alt=""
          loading="lazy"
          @error="previewFailed(imagery.key)"
        />
        <div v-else class="card__placeholder">
          <template v-if="imagery.granuleLayer && !imagery.granuleLayer.pictures">
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
      </div>
      <div v-if="imagery.granuleLayer" class="card__body">
        <div class="card__title">{{ RECORDED_SWATH }}</div>
        <div class="card__detail">{{ imagery.label }}, as the clock runs</div>
        <div class="card__actions">
          <USwitch
            :model-value="isShown(imagery)"
            label="Show"
            size="sm"
            :aria-label="`Show ${imagery.label} as a map layer`"
            @update:model-value="cesiumStore.toggleInstrumentImagery(imagery.token!, $event)"
            @click.stop
          />
          <UTooltip :text="isTracked ? 'Stop tracking' : 'Track the satellite'">
            <UButton icon="i-lucide-video" variant="ghost" :color="isTracked ? 'primary' : 'neutral'" size="xs" aria-label="Track the satellite" @click.stop="toggleTrack" />
          </UTooltip>
        </div>
        <!-- NASA lists a granule about 3 hours after it is sensed: nearer live there is nothing to show. -->
        <div v-if="isShown(imagery) && aheadOfData(imagery)" class="card__hint" @click.stop>
          <UIcon name="lucide:clock-alert" class="card__hint-icon" />
          <span v-if="imagery.preview?.end">Nothing sensed at this time. The layer ended on {{ imagery.preview.end }}.</span>
          <span v-else>Nothing sensed yet at this time. The latest is {{ behindLive(latest.get(imagery.key)!.newest) }} behind live.</span>
          <button type="button" class="card__hint-action" @click="goToLatest(imagery)">Go to latest</button>
        </div>
        <a v-if="imagery.href" class="card__open card__open--below" :href="imagery.href" :title="`Open in ${imagery.viewer}`" target="_blank" rel="noopener" @click.stop>
          {{ imagery.viewer }}
          <UIcon name="lucide:external-link" />
        </a>
      </div>
      <div v-else class="card__body">
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
import { computed, nextTick, onMounted, onUnmounted, reactive, useTemplateRef, watch } from "vue";

import { useController } from "@/composables/useController";
import { useSelectedEntity } from "@/composables/useSelectedEntity";
import { useViewerClock } from "@/composables/useViewerClock";
import { imageryPreviewUrl, isGranuleLayer, RECORDED_SWATH, PREVIEW_HEIGHT, PREVIEW_WIDTH, type PreviewCentre, previewBounds } from "@/config/instrumentImagery";
import { geoMosaicPreview } from "@/modules/GeoMosaicImagery";
import { PICTURE_TRIES } from "@/modules/granulePictures";
import { AFTER_OVERPASS_MS, granuleCentre, latestGranule, type LatestGranules, REPLAY_LEAD_MS } from "@/modules/overpassReplay";
import type { Granule } from "@/modules/util/cmrGranules";
import type { ImageryInfo } from "@/modules/util/entityInfo";
import { useCesiumStore } from "@/stores/cesium";

/**
 * The Imagery tab: a card for each layer that shows one of the satellite's instruments,
 * with a picture of its latest frame, a switch that shows it on the globe where the globe
 * can draw it, and a link to it in its provider's viewer. A granule layer's card can also
 * track the satellite, and sends the clock to its newest granule where it is past it.
 */
const props = defineProps<{
  layers: { instrument: string; imagery: ImageryInfo }[];
  centre: PreviewCentre | undefined;
  geostationary: boolean;
  /** The instrument whose first card is scrolled into view. */
  focus: string | undefined;
}>();

const cesiumStore = useCesiumStore();
/** Previews that could not be had, by card, which show the placeholder instead; forgotten with the satellite. */
const failed = reactive(new Set<string>());
/** Errors of each card's preview so far; a new one asks again, up to PICTURE_TRIES. */
const previewErrors = reactive(new Map<string, number>());

/** A preview that did not load is asked for again: GIBS's WMS answers about one in five with an error. */
function previewFailed(key: string): void {
  const errors = (previewErrors.get(key) ?? 0) + 1;
  previewErrors.set(key, errors);
  if (errors >= PICTURE_TRIES) {
    failed.add(key);
  }
}

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
  previewErrors.clear();
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
 * A granule layer's newest day granule with pixels, by card, which it pictures and goes to:
 * its latest frame is a granule that may be by night, or one GIBS left out.
 */
const latest = reactive(new Map<string, LatestGranules>());
/** How often the newest granule is asked again while the tab is open: CMR lists one every 6 minutes. */
const LATEST_REFRESH_MS = 10 * 60 * 1000;
watch(
  () => props.layers,
  (layers, _, onCleanup) => {
    latest.clear();
    const reading = new AbortController();
    const ask = () => {
      for (const { imagery } of layers) {
        const layer = imagery.granuleLayer;
        if (!isGranuleLayer(layer)) continue;
        void latestGranule(layer, reading.signal).then((granules) => {
          if (granules !== undefined && !reading.signal.aborted) latest.set(imagery.key, granules);
        });
      }
    };
    ask();
    const timer = layers.some(({ imagery }) => imagery.granuleLayer) ? setInterval(ask, LATEST_REFRESH_MS) : undefined;
    onCleanup(() => {
      reading.abort();
      clearInterval(timer);
    });
  },
  { immediate: true },
);

/** Degrees either side of a granule's centre in its picture: a NOAA-20 granule is about 3,000 km across. */
const GRANULE_HALF_WIDTH = 20;

const controller = useController();
const { isTracked, toggleTrack } = useSelectedEntity(controller);
const { now } = useViewerClock();

/** The clock is past the newest granule the layer has, so it shows nothing new. */
function aheadOfData(imagery: ImageryInfo): boolean {
  const granule = latest.get(imagery.key)?.newest;
  return granule !== undefined && now.value.getTime() > granule.end + AFTER_OVERPASS_MS;
}

/** "42 min", "3 h 12 min", "1 d 2 h". */
function behindLive(granule: Granule): string {
  const minutes = Math.max(0, Math.round((Date.now() - granule.start) / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  return hours === 0 ? `${minutes} min` : `${hours} h ${minutes % 60} min`;
}

/** The clock to a few minutes before the newest granule the card pictures, so the satellite flies onto it; pinned in the url. */
function goToLatest(imagery: ImageryInfo): void {
  const granule = latest.get(imagery.key)?.pictured;
  if (granule === undefined) return;
  const time = granule.start - REPLAY_LEAD_MS;
  controller.setTime(time);
  cesiumStore.setTime(new Date(time).toISOString());
}

/** Each card's picture by card: a provider's WMS answer, or one made here. */
const previews = computed(() => {
  const where = bounds.value;
  const asked = new Date();
  return new Map(
    props.layers.flatMap(({ imagery }) => {
      const granule = latest.get(imagery.key)?.pictured;
      if (imagery.preview && granule !== undefined) {
        // Held off the antimeridian, where GIBS's WMS draws nothing for a box that crosses it.
        const { latitude, longitude } = granuleCentre(granule);
        const centre = { latitude, longitude: Math.max(-180 + GRANULE_HALF_WIDTH, Math.min(180 - GRANULE_HALF_WIDTH, longitude)) };
        return [[imagery.key, imageryPreviewUrl({ ...imagery.preview, granule: granule.start }, previewBounds(centre, GRANULE_HALF_WIDTH), asked)] as const];
      }
      if (!imagery.preview || where === undefined || imagery.granuleLayer) return [];
      const url = isGeoring(imagery) ? madePreviews.get(imagery.key) : imageryPreviewUrl(imagery.preview, where, asked);
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

/* The clock past the newest granule: amber, as the clock deck's reset. */
.card__hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: #ffb02e1a;
  color: var(--panel-amber);
  font-size: 11.5px;
  line-height: 1.35;
  cursor: default;
}

.card__hint-icon {
  flex: none;
}

.card__hint-action {
  color: var(--panel-accent);
  font-weight: 600;
  cursor: pointer;
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

.card__open--below {
  margin-top: 6px;
  font-size: 12px;
}

.card__open:hover {
  color: var(--panel-ink);
}
</style>
