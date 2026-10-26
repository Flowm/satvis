<template>
  <UModal
    v-model:open="open"
    title="About Satvis"
    :ui="{ overlay: 'bg-black/40', content: 'bg-(--panel-surface-dense) text-(--panel-ink) divide-neutral-600 max-w-2xl', header: 'p-2 sm:px-3', body: 'p-3 sm:p-3' }"
  >
    <!-- The trigger, which the dialog returns focus to when it closes. -->
    <slot />
    <template #body>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="content" class="about about--dialog" v-html="content"></div>
      <div v-else class="about about--dialog">
        <p v-if="failed">The about page could not be loaded. <a href="/about">Open it directly</a>.</p>
        <p v-else>Loading…</p>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

import "../css/about.css";

const open = ref(false);
const content = ref("");
const failed = ref(false);

// The about page is the only copy of the content; the dialog lifts its `#about-content`.
// `v-html` runs no scripts from it. Fetches `about.html`, not `/about`: only that url
// is precached (vite.config.ts globPatterns), and `/about` 307s on the network.
watch(open, async (isOpen) => {
  if (!isOpen || content.value || failed.value) {
    return;
  }
  try {
    const response = await fetch("about.html");
    if (!response.ok) {
      throw new Error(`about.html: ${response.status}`);
    }
    const main = new DOMParser().parseFromString(await response.text(), "text/html").getElementById("about-content");
    if (!main) {
      throw new Error("about.html has no #about-content");
    }
    content.value = main.innerHTML;
  } catch (error) {
    console.warn("Could not load the about content", error);
    failed.value = true;
  }
});
</script>
