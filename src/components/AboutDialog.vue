<template>
  <!-- Teleported into #app, which carries `dark`: in body its header, close button and overlay take Nuxt UI's light theme.
       There it needs a z-index above the toolbars' (main.css), which it otherwise follows in the DOM. -->
  <UModal
    v-model:open="open"
    portal="#app"
    title="About Satvis"
    :ui="{
      overlay: 'z-30 bg-black/40',
      content: 'z-30 bg-(--panel-surface-dense) text-(--panel-ink) divide-neutral-600 max-w-2xl',
      header: 'p-2 sm:px-3',
      body: 'p-3 sm:p-3',
    }"
  >
    <!-- The trigger, which the dialog returns focus to when it closes. -->
    <slot />
    <template #body>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="content" :ref="attach" class="about about--dialog" @click="openDemo" v-html="content"></div>
      <div v-else class="about about--dialog">
        <p v-if="failed">The about page could not be loaded. <a href="/about">Open it directly</a>.</p>
        <p v-else>Loading…</p>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { type ComponentPublicInstance, ref, watch } from "vue";

import { useBookmarks } from "../composables/useBookmarks";
import { attachCarousel } from "../modules/util/carousel";

import "../css/about.css";

const open = ref(false);
const content = ref("");
const failed = ref(false);

const { demos, open: openBookmark } = useBookmarks();

/** The content element the carousel is wired to, and the undo; the modal unmounts it when closed. */
let attached: { element: Element; detach: () => void } | undefined;

/** Wires the demo carousel each time the content mounts. */
function attach(element: Element | ComponentPublicInstance | null): void {
  if (element === attached?.element) {
    return;
  }
  attached?.detach();
  attached = undefined;
  const carousel = element instanceof Element ? element.querySelector<HTMLElement>(".demoCarousel") : null;
  if (element instanceof Element && carousel) {
    attached = { element, detach: attachCarousel(carousel) };
  }
}

/** A demo opens in place, as its bookmark card does; a modified click opens its url, as any link. */
function openDemo(event: MouseEvent): void {
  const id = (event.target as Element).closest<HTMLElement>("[data-demo]")?.dataset.demo;
  const demo = demos.find((bookmark) => bookmark.id === id);
  if (!demo || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  openBookmark(demo);
  open.value = false;
}

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
