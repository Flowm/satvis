<template>
  <UModal v-model:open="open" title="About Satvis" :ui="{ content: 'bg-[#303336]/95 text-[#edffff] divide-neutral-600 max-w-2xl', header: 'p-2 sm:px-3', body: 'p-3 sm:p-3' }">
    <UTooltip text="About">
      <!-- A link, not a button: it is the only reference crawlers find to /about, and middle-click opens the page. -->
      <a class="cesium-button cesium-toolbar-button" href="/about" aria-label="About Satvis" @click.prevent>
        <UIcon name="lucide:info" />
      </a>
    </UTooltip>
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

/**
 * The about page is the only copy of the content; the dialog lifts its `#about-content`.
 * `v-html` runs no scripts from it. Fetches `about.html`, not `/about`: only that url
 * is precached (vite.config.ts globPatterns), and `/about` 307s on the network.
 */
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
