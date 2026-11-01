<template>
  <!-- Teleported into #app, which carries `dark`: in body its header, close button and overlay take Nuxt UI's light theme.
       There it needs a z-index above the toolbars' (main.css), which it otherwise follows in the DOM. -->
  <UModal
    v-model:open="open"
    portal="#app"
    title="About Satvis"
    :ui="{
      overlay: 'z-30 bg-black/40',
      content: 'z-30 bg-(--panel-surface-dense) text-(--panel-ink) divide-neutral-600 max-w-xl',
      header: 'py-2 px-4 sm:px-5',
      body: 'p-4 sm:p-5',
    }"
  >
    <!-- The trigger, which the dialog returns focus to when it closes. -->
    <slot />
    <template #body>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="content" ref="lifted" class="about about--dialog" @click="openFeatured" v-html="content"></div>
      <div v-else class="about about--dialog">
        <p v-if="failed">The about page could not be loaded. <a href="/about">Open it directly</a>.</p>
        <p v-else>Loading…</p>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { ref, useTemplateRef, watch } from "vue";

import { useBookmarks } from "../composables/useBookmarks";
import { type Bookmark, type Link, sameLink } from "../modules/util/bookmarks";
import { attachCarousel } from "../modules/util/carousel";

import "../css/about.css";

const open = ref(false);
const content = ref("");
const failed = ref(false);

const { featured, onDefaultPreset, open: openBookmark } = useBookmarks();
const lifted = useTemplateRef<HTMLElement>("lifted");

// The modal mounts the content afresh each time it opens.
watch(lifted, (element) => {
  const carousel = element?.querySelector<HTMLElement>(".featuredCarousel");
  if (carousel) {
    attachCarousel(carousel);
  }
});

/** The scene a carousel slide links to. */
function slideLink(slide: Element): Link {
  const url = new URL(slide.getAttribute("href") ?? "", window.location.href);
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

/** The route's featured bookmark a carousel slide links to, if it is one. */
const featuredOf = (slide: Element): Bookmark | undefined => featured.value.find((bookmark) => sameLink(bookmark, slideLink(slide)));

/**
 * A featured bookmark opens in place, as its card does. A modified click, or a slide the route
 * features no bookmark for yet, before the group index arrives, opens its url as any link.
 */
function openFeatured(event: MouseEvent): void {
  const slide = (event.target as Element).closest(".featuredCarousel__link");
  const bookmark = slide ? featuredOf(slide) : undefined;
  if (!bookmark || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  openBookmark(bookmark);
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
    // The carousel shows the default preset's featured bookmarks, which on another preset's
    // route would open another preset: that route's own are in the Bookmarks panel.
    if (!onDefaultPreset.value) {
      main.querySelector(".about-featured")?.remove();
    }
    content.value = main.innerHTML;
  } catch (error) {
    console.warn("Could not load the about content", error);
    failed.value = true;
  }
});
</script>
