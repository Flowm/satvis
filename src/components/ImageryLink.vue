<template>
  <div class="imageryRow">
    <a class="imageryLink" :href="imagery.href" :title="`Open in ${imagery.viewer}`" target="_blank" rel="noopener">
      <span class="imageryLink__label">{{ imagery.label }}</span>
      <UIcon name="lucide:external-link" class="imageryLink__icon" />
      <span class="imageryLink__detail">{{ imagery.detail ? `${imagery.detail} · ${imagery.viewer}` : imagery.viewer }}</span>
    </a>
    <button
      v-if="imagery.token"
      type="button"
      class="imageryShow"
      :class="{ 'imageryShow--on': shown }"
      :aria-pressed="shown"
      :aria-label="`Show ${imagery.label} on the globe`"
      :title="shown ? 'Take it off the globe' : 'Show it on the globe'"
      @click="cesiumStore.toggleInstrumentImagery(imagery.token, !shown)"
    >
      <UIcon name="lucide:globe" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import type { ImageryInfo } from "@/modules/util/entityInfo";
import { useCesiumStore } from "@/stores/cesium";

/**
 * One layer of an instrument's imagery in the Instruments tab: a link to it in its
 * provider's viewer, and where the globe can draw it, a button that shows it there.
 */
const props = defineProps<{ imagery: ImageryInfo }>();

const cesiumStore = useCesiumStore();
const shown = computed(() => props.imagery.token !== undefined && cesiumStore.instrumentImagery.includes(props.imagery.token));
</script>

<style scoped>
.imageryRow {
  display: flex;
  align-items: center;
  gap: 4px;
}

.imageryLink {
  display: grid;
  flex: 1;
  grid-template-columns: 1fr auto;
  column-gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
  font-size: 12.5px;
}

.imageryLink:hover,
.imageryShow:hover {
  background: #ffffff14;
}

.imageryLink__icon {
  align-self: center;
  color: #edffff90;
}

.imageryLink__detail {
  grid-column: 1 / -1;
  color: #edffffb0;
  font-size: 11.5px;
}

/* 32 px: a finger's target on the phone, where the row is as tall. */
.imageryShow {
  display: grid;
  width: 32px;
  height: 32px;
  flex: none;
  place-items: center;
  border-radius: 4px;
  color: #edffff90;
  cursor: pointer;
}

.imageryShow--on {
  background: var(--panel-selected);
  color: var(--panel-accent);
}
</style>
