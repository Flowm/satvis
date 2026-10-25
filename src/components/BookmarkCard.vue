<!-- One bookmark: its picture, name, satellites and camera; the time on the picture. -->
<template>
  <UContextMenu v-model:open="pressMenuOpen" :items="actions" :disabled="renaming" :content="menuContent" :ui="menuUi" :size="menuSize">
    <div class="bookmarkCard" :class="{ 'bookmarkCard--current': current }">
      <form v-if="renaming" class="bookmarkCard__rename" @submit.prevent="emit('commit')">
        <img v-if="thumbnailUrl" :src="thumbnailUrl" alt="" class="bookmarkCard__thumb" />
        <span v-else class="bookmarkCard__thumb bookmarkCard__thumb--none"><UIcon name="lucide:image-off" /></span>
        <input
          ref="nameInput"
          :value="draft"
          type="text"
          aria-label="Bookmark name"
          @input="emit('update:draft', ($event.target as HTMLInputElement).value)"
          @keydown.esc.stop.prevent="emit('cancel')"
          @blur="onBlur"
        />
      </form>
      <button v-else type="button" class="bookmarkCard__open" :aria-current="current || undefined" @click="pressMenuOpen || emit('open')">
        <span class="bookmarkCard__media">
          <img v-if="thumbnailUrl" :src="thumbnailUrl" alt="" class="bookmarkCard__thumb" loading="lazy" />
          <span v-else class="bookmarkCard__thumb bookmarkCard__thumb--none"><UIcon name="lucide:image-off" /></span>
          <span class="bookmarkCard__badge bookmarkCard__badge--time" :class="{ 'bookmarkCard__badge--live': !summary.time }">{{ summary.time ?? "● Live" }}</span>
          <span v-if="bookmark.kind === 'opened'" class="bookmarkCard__badge bookmarkCard__badge--age">{{ timeAgo(bookmark.at) }}</span>
        </span>
        <span class="bookmarkCard__name">{{ bookmark.name }}</span>
        <span class="bookmarkCard__fact"><UIcon name="lucide:orbit" class="bookmarkCard__icon" />{{ summary.what }}</span>
        <span class="bookmarkCard__fact"><UIcon :name="whereIcon" class="bookmarkCard__icon" />{{ summary.where }}</span>
      </button>
      <UDropdownMenu v-if="!renaming" :items="actions" :content="{ align: 'end', ...menuContent }" :ui="menuUi" :size="menuSize">
        <button type="button" class="bookmarkCard__more" :aria-label="`Actions for ${bookmark.name}`"><UIcon name="lucide:ellipsis" /></button>
      </UDropdownMenu>
    </div>
  </UContextMenu>
</template>

<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import { computed, nextTick, ref, watch } from "vue";

import { type Bookmark, type BookmarkSummary, timeAgo } from "../modules/util/bookmarks";
import { DeviceDetect } from "../modules/util/DeviceDetect";

/** `draft` is the name being typed, held by the panel, whose footer can save it too. */
const props = defineProps<{ bookmark: Bookmark; summary: BookmarkSummary; current: boolean; renaming: boolean; draft: string }>();
const emit = defineEmits<{ open: []; rename: []; "update:draft": [name: string]; commit: []; cancel: []; remove: []; keep: []; share: [] }>();

/** A demo's picture is a path under the app's base; a saved one is a data url. */
const thumbnailUrl = computed(() => {
  const { thumbnail } = props.bookmark;
  return thumbnail && !thumbnail.startsWith("data:") ? `${import.meta.env.BASE_URL}${thumbnail}` : thumbnail;
});

/** The icon of the Sky, Globe or tracking camera. */
const whereIcon = computed(() => (props.summary.where.startsWith("Sky") ? "lucide:telescope" : props.summary.where.startsWith("Following") ? "lucide:crosshair" : "lucide:globe"));

/**
 * The native app's actions, its labels, order and icons (BookmarksView.swift), behind "…" and, as
 * there, a long press; a right click too.
 */
const actions = computed<DropdownMenuItem[]>(() => [
  { label: "Share", icon: "lucide:share", onSelect: () => emit("share") },
  ...(props.bookmark.kind === "saved"
    ? [
        { label: "Rename", icon: "lucide:pencil", onSelect: () => emit("rename") },
        { label: "Delete", icon: "lucide:trash-2", color: "error" as const, onSelect: () => emit("remove") },
      ]
    : props.bookmark.kind === "opened"
      ? [
          { label: "Save", icon: "lucide:bookmark", onSelect: () => emit("keep") },
          { label: "Forget", icon: "lucide:x", onSelect: () => emit("remove") },
        ]
      : []),
]);

/** The menu a long press opened, which the click of the finger lifting must leave open, not the bookmark. */
const pressMenuOpen = ref(false);

/** Rename and Save open the name, which the menu would otherwise take the focus back from. */
const menuContent = {
  onCloseAutoFocus: (event: Event) => {
    if (props.renaming) {
      event.preventDefault();
    }
  },
};
/** The menu on the panel's own surface; `dark` as `#app` is, which the menu is portalled out of. */
const menuUi = { content: "dark bg-(--panel-surface)/95 text-(--panel-ink) ring-white/10" };
/** Rows a finger can hit, as the native app's are. */
const menuSize = DeviceDetect.hasTouch() ? "xl" : "md";

const nameInput = ref<HTMLInputElement>();

watch(
  () => props.renaming,
  (renaming) => {
    if (!renaming) {
      return;
    }
    void nextTick(() => {
      nameInput.value?.focus();
      nameInput.value?.select();
    });
  },
  { immediate: true },
);

/**
 * Leaving the field keeps the name, unless for the control that saves it (`data-saves-name`),
 * which would otherwise find the edit already over.
 */
function onBlur(event: FocusEvent): void {
  if (props.renaming && !(event.relatedTarget as HTMLElement | null)?.closest("[data-saves-name]")) {
    emit("commit");
  }
}
</script>

<style scoped>
.bookmarkCard {
  position: relative;
  overflow: hidden;
  background: var(--panel-raised);
  border: 2px solid transparent;
  border-radius: 8px;
}

.bookmarkCard--current {
  border-color: var(--panel-accent);
}

.bookmarkCard__open,
.bookmarkCard__rename {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0 0 7px;
  background: none;
  border: none;
  color: var(--panel-ink);
  text-align: left;
}

.bookmarkCard__open {
  cursor: pointer;
}

.bookmarkCard__open:focus-visible {
  outline: 2px solid var(--panel-accent);
  outline-offset: -2px;
}

.bookmarkCard__media {
  position: relative;
  display: flex;
}

.bookmarkCard__thumb {
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: cover;
  background: #000;
}

.bookmarkCard__thumb--none {
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.4;
}

.bookmarkCard__badge {
  position: absolute;
  left: 5px;
  padding: 2px 6px;
  background: #000b;
  border-radius: 6px;
  font-size: 11px;
  line-height: 14px;
}

.bookmarkCard__badge--time {
  bottom: 5px;
}

.bookmarkCard__badge--live {
  color: #8fe39b;
}

.bookmarkCard__badge--age {
  top: 5px;
}

.bookmarkCard__name {
  padding: 5px 7px 1px;
  font-size: 13px;
  line-height: 16px;
}

.bookmarkCard__fact {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  padding: 1px 7px 0;
  font-size: 11px;
  line-height: 14px;
  opacity: 0.8;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bookmarkCard__icon {
  flex: none;
  width: 11px;
  height: 11px;
  opacity: 0.7;
}

.bookmarkCard__rename input {
  margin: 5px 5px 0;
  padding: 3px 5px;
  background: #000;
  border: 1px solid var(--panel-accent);
  border-radius: 5px;
  color: var(--panel-ink);
  font-size: 13px;
}

/* The native app's: 28 px round, its hit area 36. */
.bookmarkCard__more {
  position: absolute;
  top: 4px;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: #000b;
  border: none;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
}

.bookmarkCard__more::before {
  position: absolute;
  inset: -4px;
  content: "";
}

.bookmarkCard__more:focus-visible {
  outline: 2px solid var(--panel-accent);
}
</style>
