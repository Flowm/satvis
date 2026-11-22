<template>
  <div ref="galleryEl" class="gallery">
    <article
      v-for="{ instrument, imagery } in cards"
      :key="imagery.key"
      class="card"
      :class="{ 'card--drawable': imagery.token, 'card--shown': isShown(imagery) }"
      :data-instrument="instrument"
      :aria-label="`${IMAGERY_TYPES[imagery.type].title}, ${imagery.words.picture}`"
      @click="toggle(imagery)"
    >
      <div class="card__preview">
        <img
          v-if="previews.get(imagery.key) && !failed.has(imagery.key) && previewErrorsOf(imagery.key) < PICTURE_TRIES"
          :key="`${previews.get(imagery.key)}#${previewErrorsOf(imagery.key)}`"
          :src="previews.get(imagery.key)"
          alt=""
          loading="lazy"
          @error="previewErrors.set(previews.get(imagery.key)!, previewErrorsOf(imagery.key) + 1)"
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
        <span v-if="captionOf(imagery)" class="card__caption" :class="{ 'card__caption--ended': imagery.words.ended }">{{ captionOf(imagery) }}</span>
      </div>
      <div class="card__body">
        <div class="card__title">
          <UIcon :name="IMAGERY_TYPES[imagery.type].icon" class="card__title-icon" />
          {{ IMAGERY_TYPES[imagery.type].title }}
        </div>
        <div class="card__picture">{{ imagery.words.picture }}</div>
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
          <span class="card__buttons">
            <UTooltip v-if="imagery.granuleLayer" :text="isTracked ? 'Stop tracking' : 'Track the satellite'">
              <UButton icon="i-lucide-video" variant="ghost" :color="isTracked ? 'primary' : 'neutral'" size="xs" aria-label="Track the satellite" @click.stop="toggleTrack" />
            </UTooltip>
            <!-- A layer the globe cannot draw is its viewer's alone: the link is its action. -->
            <UTooltip v-if="imagery.href && !imagery.token" :text="`Open in ${imagery.viewer}`">
              <UButton
                icon="i-lucide-external-link"
                variant="ghost"
                color="neutral"
                size="xs"
                :to="imagery.href"
                target="_blank"
                :aria-label="`Open in ${imagery.viewer}`"
                @click.stop
              />
            </UTooltip>
            <UButton
              icon="i-lucide-info"
              variant="ghost"
              :color="aboutOpen.has(imagery.key) ? 'primary' : 'neutral'"
              size="xs"
              aria-label="About this layer"
              :aria-expanded="aboutOpen.has(imagery.key)"
              @click.stop="toggleAbout(imagery.key)"
            />
          </span>
        </div>
        <dl v-if="aboutOpen.has(imagery.key)" class="card__about" @click.stop>
          <template v-if="imagery.words.updates">
            <dt>Updates</dt>
            <dd :class="{ card__ended: imagery.words.ended }">{{ imagery.words.updates }}</dd>
          </template>
          <template v-if="imagery.words.archive">
            <dt>Archive</dt>
            <dd>{{ imagery.words.archive }}</dd>
          </template>
          <template v-if="imagery.href">
            <dt>Source</dt>
            <dd>
              <a class="card__open" :href="imagery.href" target="_blank" rel="noopener">
                {{ imagery.viewer }}
                <UIcon name="lucide:external-link" />
              </a>
            </dd>
          </template>
        </dl>
        <PassNotice
          v-if="isShown(imagery) && isPastNewest(imagery.key)"
          class="card__notice"
          :newest="latest.get(imagery.key)!.pictured.start"
          :now="wallClock"
          @go="goToNewest(imagery.key)"
        />
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, useTemplateRef, watch } from "vue";

import { useController } from "@/composables/useController";
import { useLatestPasses } from "@/composables/useLatestPasses";
import { useSelectedEntity } from "@/composables/useSelectedEntity";
import { IMAGERY_TYPES, imageryPreviewUrl, isGranuleLayer, PREVIEW_HEIGHT, PREVIEW_WIDTH, type PreviewCentre, previewBounds } from "@/config/instrumentImagery";
import { geoMosaicPreview } from "@/modules/GeoMosaicImagery";
import { PICTURE_TRIES } from "@/modules/granulePictures";
import { granuleCentre } from "@/modules/overpassReplay";
import type { ImageryInfo } from "@/modules/util/entityInfo";
import { formatDate, timeAgo } from "@/modules/util/formats";
import { useCesiumStore } from "@/stores/cesium";

import PassNotice from "./PassNotice.vue";

/**
 * The Imagery tab (ADR 0024): a card for each layer that shows one of the satellite's
 * instruments, titled by its type, with a picture of its latest frame and how fresh it is,
 * a switch that shows it on the globe where the globe can draw it, and the rest behind its
 * info button. A granule layer's card can also track the satellite, and sends the clock to
 * its newest pass where it is past it.
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
/**
 * Errors of each preview so far, by its url; a new one asks again, up to PICTURE_TRIES, as
 * GIBS's WMS answers about one request in five with an error. A newer granule's is a new url.
 */
const previewErrors = reactive(new Map<string, number>());
const previewErrorsOf = (key: string) => previewErrors.get(previews.value.get(key) ?? "") ?? 0;

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

const { latest, wallClock, isPastNewest, goToNewest } = useLatestPasses(() =>
  props.layers.flatMap(({ imagery }) => (isGranuleLayer(imagery.granuleLayer) ? [{ key: imagery.key, layer: imagery.granuleLayer }] : [])),
);

/** Degrees either side of a granule's centre in its picture: a NOAA-20 granule is about 3,000 km across. */
const GRANULE_HALF_WIDTH = 20;

const controller = useController();
const { isTracked, toggleTrack } = useSelectedEntity(controller);

/** The cards in the record's order, a layer that ended after those that have not. */
const cards = computed(() => props.layers.toSorted((a, b) => Number(a.imagery.words.ended) - Number(b.imagery.words.ended)));

/** How fresh a card's picture is: the day a stopped layer ended, the pass pictured, yesterday's for a day's. */
function captionOf(imagery: ImageryInfo): string | undefined {
  const end = imagery.preview?.end;
  if (end !== undefined) return `Last day, ${formatDate(end)}`;
  if (imagery.type === "passes") {
    const pictured = latest.get(imagery.key)?.pictured;
    return pictured === undefined ? undefined : `Newest pass, ${timeAgo(pictured.start, wallClock.value)}`;
  }
  if (imagery.preview === undefined) return undefined;
  return imagery.preview.daily ? "Yesterday" : "Latest";
}

/** The cards whose info button is open: forgotten with the satellite. */
const aboutOpen = reactive(new Set<string>());
watch(
  () => props.layers,
  () => aboutOpen.clear(),
);
/** Opens the card's Updates, Archive and Source, or closes them. */
const toggleAbout = (key: string) => (aboutOpen.has(key) ? aboutOpen.delete(key) : aboutOpen.add(key));

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

.card__body {
  padding: 8px 10px 10px;
}

/* How fresh the picture is, over its corner. */
.card__caption {
  position: absolute;
  bottom: 6px;
  left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: #000000b0;
  font-size: 11px;
}

/* Amber: the app colour for "away from rest", as on the status chip. */
.card__caption--ended,
.card__ended {
  color: var(--panel-amber);
}

.card__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  font-weight: 600;
}

.card__title-icon {
  flex: none;
  color: var(--panel-muted);
}

.card__picture {
  font-size: 12.5px;
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

.card__buttons {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* What the info button opens: when it updates, how far back it goes, and where it comes from. */
.card__about {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--panel-hairline);
  font-size: 12px;
  cursor: default;
}

.card__about dt {
  color: var(--panel-muted);
}

.card__notice {
  margin-top: 8px;
}

.card__open:hover {
  color: var(--panel-ink);
}
</style>
