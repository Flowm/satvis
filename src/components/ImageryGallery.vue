<template>
  <div ref="galleryEl" class="gallery">
    <article
      v-for="{ instrument, imagery } in layers"
      :key="imagery.href"
      class="card"
      :class="{ 'card--drawable': imagery.token, 'card--shown': isShown(imagery) }"
      :data-instrument="instrument"
      :aria-label="`${instrument} ${imagery.label}`"
      @click="toggle(imagery)"
    >
      <div class="card__preview">
        <img v-if="previewOf(imagery) && !failed.has(imagery.href)" :src="previewOf(imagery)" alt="" loading="lazy" @error="failed.add(imagery.href)" />
        <div v-else class="card__placeholder">
          <UIcon name="lucide:image-off" />
          <span>No preview</span>
        </div>
        <span class="card__badge">{{ instrument }}</span>
        <span v-if="imagery.preview?.end" class="card__badge card__badge--ended">Ended {{ imagery.preview.end }}</span>
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
            :aria-label="`Show ${imagery.label} on the globe`"
            @update:model-value="cesiumStore.toggleInstrumentImagery(imagery.token, $event)"
            @click.stop
          />
          <span v-else />
          <a class="card__open" :href="imagery.href" :title="`Open in ${imagery.viewer}`" target="_blank" rel="noopener" @click.stop>
            {{ imagery.viewer }}
            <UIcon name="lucide:external-link" />
          </a>
        </div>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, reactive, useTemplateRef, watch } from "vue";

import { imageryPreviewUrl, type PreviewCentre } from "@/config/instrumentImagery";
import type { ImageryInfo } from "@/modules/util/entityInfo";
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
}>();

const cesiumStore = useCesiumStore();
/** Previews the provider refused, by link, which show the placeholder instead. */
const failed = reactive(new Set<string>());

/** A geostationary imager sees a disc about 80° either side; a low one is pictured where it flies. */
const halfWidthDeg = () => (props.geostationary ? 72 : 32);

function previewOf(imagery: ImageryInfo): string | undefined {
  return imagery.preview && props.centre ? imageryPreviewUrl(imagery.preview, props.centre, halfWidthDeg(), new Date()) : undefined;
}

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
