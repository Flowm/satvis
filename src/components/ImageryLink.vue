<template>
  <a class="imageryLink" :href="imagery.href" :title="`Open in ${imagery.viewer}`" target="_blank" rel="noopener">
    <span class="imageryLink__label">{{ imagery.label }}</span>
    <UIcon name="lucide:external-link" class="imageryLink__icon" />
    <span class="imageryLink__detail">{{ imagery.detail ? `${imagery.detail} · ${imagery.viewer}` : imagery.viewer }}</span>
  </a>
</template>

<script setup lang="ts">
import type { ImageryInfo } from "@/modules/util/entityInfo";

/** One layer of an instrument's imagery in the Instruments tab: a link to it in its provider's viewer. */
defineProps<{ imagery: ImageryInfo }>();
</script>

<style scoped>
.imageryLink {
  display: grid;
  grid-template-columns: 1fr auto;
  column-gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
  font-size: 12.5px;
}

.imageryLink:hover {
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
</style>
