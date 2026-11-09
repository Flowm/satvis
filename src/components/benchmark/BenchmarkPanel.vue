<!--
  The benchmark panel (ADR 0016, src/modules/benchmark/README.md): the preset's scenes and the
  sweep, the same options and wording as the native app's BenchmarkPanel. Plain CSS, not Nuxt
  UI, to fit a dozen numbers densely. It shares `window.bench` with the console.
-->
<template>
  <section class="bench" aria-label="Benchmark">
    <header class="bench__header">
      <div class="bench__heading">
        <h2 class="bench__title">Benchmark</h2>
        <p class="bench__status" role="status">{{ panel.status.value }}</p>
      </div>
      <button type="button" class="bench__close" aria-label="Close" @click="emit('close')">×</button>
    </header>
    <div class="bench__progress" :class="{ 'bench__progress--off': panel.progressFraction.value === null }">
      <div class="bench__progress-fill" :style="{ width: `${(panel.progressFraction.value ?? 0) * 100}%` }" />
    </div>
    <!-- Locked during a run: the other tab's settings would not apply to it. -->
    <div class="bench__tabs" role="tablist">
      <button
        v-for="option in TABS"
        :key="option.value"
        type="button"
        role="tab"
        class="bench__tab"
        :aria-selected="panel.tab.value === option.value"
        :disabled="panel.running.value && panel.tab.value !== option.value"
        @click="panel.tab.value = option.value"
      >
        {{ option.label }}
      </button>
    </div>
    <div class="bench__body">
      <benchmark-scenes v-if="panel.tab.value === 'scenes'" />
      <benchmark-sweep v-else />
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";

import { useController } from "@/composables/useController";
import { resolvePreset } from "@/config/presets";
import { installBenchmark } from "@/modules/benchmark";
import { withoutBenchmarkRun } from "@/modules/util/bookmarks";
import { router } from "@/router";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

import { provideBenchmarkPanel, type Tab } from "./benchmarkPanel";
import BenchmarkScenes from "./BenchmarkScenes.vue";
import BenchmarkSweep from "./BenchmarkSweep.vue";

const emit = defineEmits<{ close: [] }>();

const TABS: { value: Tab; label: string }[] = [
  { value: "scenes", label: "Scenes" },
  { value: "sweep", label: "Sweep" },
];

const cc = useController();
const cesiumStore = useCesiumStore();
const satStore = useSatStore();
/** Also installs `window.bench`. */
const panel = provideBenchmarkPanel(installBenchmark(cc), () => satStore.enabledComponents);

// A run, from the console too, shows on its own tab.
watch(panel.revision, () => {
  const kind = panel.bench.runner.progress?.kind;
  if (kind && panel.tab.value !== kind) {
    panel.tab.value = kind;
  }
});

onMounted(async () => {
  const scenes = (await resolvePreset(router.currentRoute.value.path)).benchmarkScenes;
  panel.scenes.value = scenes;
  panel.selected.value = scenes.map((scene) => scene.id);
  // A link asked for a run (ADR 0016). Rewritten first, so neither Back, a bookmark nor a
  // share starts another; the run then saves and restores the link as it now reads.
  if (cesiumStore.benchmarkMode === "run") {
    const only = [...cesiumStore.benchmarkScenes];
    if (only.length > 0) {
      panel.selected.value = only;
    }
    await router.replace({ query: withoutBenchmarkRun(router.currentRoute.value.query) });
    void panel.startScenes(only);
  }
});

// Closed mid-run, as the native app's: the run stops, and the view it puts back stays without the panel.
onBeforeUnmount(() => {
  if (panel.running.value) {
    panel.bench.target.dropPanel();
    panel.cancel();
  }
});
</script>

<!-- Not scoped: the tabs share it. Every class starts with `bench`. -->
<style>
/* In Satvis.vue's measurement column, under the performance panel. */
.bench {
  --bench-accent: #57c4b4;
  --bench-dim: rgba(230, 234, 240, 0.55);
  --bench-line: rgba(255, 255, 255, 0.09);
  --bench-warn: #f2b33d;
  --bench-bad: #f07178;
  --bench-good: #86c06c;
  display: flex;
  flex-direction: column;
  width: 440px;
  max-width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  background: rgba(14, 16, 21, 0.94);
  color: #e6eaf0;
  font-family:
    system-ui,
    -apple-system,
    "Segoe UI",
    sans-serif;
  font-size: 12px;
  line-height: 1.4;
  overflow: hidden;
}

.bench__header {
  display: flex;
  flex: none;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 10px 8px 12px;
}

.bench__heading {
  flex: 1;
  min-width: 0;
}

.bench__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.bench__status {
  margin: 1px 0 0;
  color: var(--bench-dim);
  font-variant-numeric: tabular-nums;
}

.bench .bench__close {
  flex: none;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  font-size: 16px;
  line-height: 1;
}

.bench__progress {
  flex: none;
  height: 3px;
  margin: 0 12px;
  border-radius: 2px;
  background: var(--bench-line);
  overflow: hidden;
}

.bench__progress--off {
  visibility: hidden;
}

.bench__progress-fill {
  height: 100%;
  background: var(--bench-accent);
  transition: width 0.4s linear;
}

.bench__tabs {
  display: flex;
  flex: none;
  gap: 2px;
  margin: 8px 12px;
  padding: 2px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.07);
}

.bench .bench__tab {
  flex: 1;
  padding: 3px 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--bench-dim);
  font-weight: 500;
}

.bench .bench__tab[aria-selected="true"] {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}

/* The body needs `min-height: 0` to shrink, or the whole panel scrolls. */
.bench__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.bench__section {
  padding: 8px 12px;
  border-top: 1px solid var(--bench-line);
}

.bench__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.bench button {
  font: inherit;
  cursor: pointer;
}

.bench button:disabled {
  opacity: 0.4;
  cursor: default;
}

.bench .bench__button {
  padding: 4px 10px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
}

.bench .bench__button--primary {
  border-color: var(--bench-accent);
  background: var(--bench-accent);
  color: #0e1015;
  font-weight: 600;
}

.bench__caption {
  margin: 4px 0 0;
  color: var(--bench-dim);
}

.bench__dim {
  color: var(--bench-dim);
}

.bench__good {
  color: var(--bench-good);
}

.bench__warn {
  color: var(--bench-warn);
}

.bench__bad {
  color: var(--bench-bad);
}

.bench__num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.bench input[type="text"],
.bench input[type="number"] {
  min-width: 0;
  padding: 2px 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.3);
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
}

.bench input[type="checkbox"],
.bench input[type="radio"] {
  accent-color: var(--bench-accent);
}
</style>
