<!-- The info panel's Model tab. Mounted only while the tab shows, so the second
     WebGL context lives no longer than it is looked at. -->
<template>
  <div class="model-view" :data-state="state">
    <div ref="containerEl" class="model-view__scene" :aria-label="`3D model of ${name}`" role="img" />
    <div v-if="state === 'loading'" class="model-view__note">Loading model…</div>
    <div v-else-if="state === 'failed'" class="model-view__note">The model could not be loaded</div>
    <UTooltip v-if="state === 'ready'" text="Reset view">
      <UButton class="model-view__reset" icon="i-lucide-rotate-ccw" variant="ghost" color="neutral" size="xs" aria-label="Reset view" @click="closeUp?.resetView()" />
    </UTooltip>
  </div>
  <div class="model-view__hint">Drag to turn · scroll or pinch to zoom</div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";

import { type CloseUpState, ModelCloseUp } from "../modules/ModelCloseUp";
import { modelUrl } from "../modules/satelliteGraphics";

const props = defineProps<{
  /** Path under /data/models/, from the satellite's metadata. */
  modelFile: string;
  name: string;
}>();

const containerEl = useTemplateRef<HTMLDivElement>("containerEl");
const state = ref<CloseUpState>("loading");
/** Not reactive: Cesium objects break under a deep proxy. */
let closeUp: ModelCloseUp | undefined;

onMounted(() => {
  closeUp = new ModelCloseUp(containerEl.value!, (next) => {
    state.value = next;
  });
  void closeUp.load(modelUrl(props.modelFile));
});

// The panel is not remounted between satellites, so a new selection swaps the model in place.
watch(
  () => props.modelFile,
  (modelFile) => void closeUp?.load(modelUrl(modelFile)),
);

onBeforeUnmount(() => {
  closeUp?.destroy();
  closeUp = undefined;
});
</script>

<style scoped>
.model-view {
  position: relative;
  height: min(280px, 36dvh);
  overflow: hidden;
  border-radius: 4px;
  background: radial-gradient(circle at 50% 40%, #15181d, #040506 75%);
  /* A drag turns the model; it must not select the panel's text. */
  -webkit-user-select: none;
  user-select: none;
}

.model-view__scene {
  position: absolute;
  inset: 0;
  touch-action: none;
}

.model-view__note {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #edffffb0;
  font-size: 13px;
  pointer-events: none;
}

.model-view__reset {
  position: absolute;
  top: 4px;
  right: 4px;
}

.model-view__hint {
  margin-top: 5px;
  color: #edffff70;
  font-size: 11px;
}
</style>
