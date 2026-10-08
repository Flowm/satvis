<!-- One bookmark: its picture, name, satellites and camera; the time on the picture. -->
<template>
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
    <button v-else type="button" class="bookmarkCard__open" :aria-current="current || undefined" @click="emit('open')">
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
    <div v-if="bookmark.kind !== 'demo' && !renaming" class="bookmarkCard__tools">
      <template v-if="bookmark.kind === 'saved'">
        <button type="button" :aria-label="`Rename ${bookmark.name}`" @click="emit('rename')"><UIcon name="lucide:pencil" /></button>
        <button type="button" :aria-label="`Delete ${bookmark.name}`" @click="emit('remove')"><UIcon name="lucide:trash-2" /></button>
      </template>
      <template v-else>
        <button type="button" :aria-label="`Save ${bookmark.name}`" @click="emit('keep')"><UIcon name="lucide:bookmark-plus" /></button>
        <button type="button" :aria-label="`Forget ${bookmark.name}`" @click="emit('remove')"><UIcon name="lucide:x" /></button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { type Bookmark, type BookmarkSummary, timeAgo } from "../modules/util/bookmarks";

/** `draft` is the name being typed, held by the panel, whose footer can save it too. */
const props = defineProps<{ bookmark: Bookmark; summary: BookmarkSummary; current: boolean; renaming: boolean; draft: string }>();
const emit = defineEmits<{ open: []; rename: []; "update:draft": [name: string]; commit: []; cancel: []; remove: []; keep: [] }>();

/** A demo's picture is a path under the app's base; a saved one is a data url. */
const thumbnailUrl = computed(() => {
  const { thumbnail } = props.bookmark;
  return thumbnail && !thumbnail.startsWith("data:") ? `${import.meta.env.BASE_URL}${thumbnail}` : thumbnail;
});

const whereIcon = computed(() => (props.summary.where.startsWith("Sky") ? "lucide:telescope" : props.summary.where.startsWith("Following") ? "lucide:crosshair" : "lucide:globe"));

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
 * which would otherwise find the edit already over. Enter keeps it too; Escape keeps the old one.
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
  background: #1f2225;
  border: 2px solid transparent;
  border-radius: 8px;
}

.bookmarkCard--current {
  border-color: #7fd2ea;
}

.bookmarkCard__open,
.bookmarkCard__rename {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0 0 7px;
  background: none;
  border: none;
  color: #edffff;
  text-align: left;
}

.bookmarkCard__open {
  cursor: pointer;
}

.bookmarkCard__open:focus-visible {
  outline: 2px solid #7fd2ea;
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
  background: #0b0f14;
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
  background: #0b0f14;
  border: 1px solid #7fd2ea;
  border-radius: 5px;
  color: #edffff;
  font-size: 13px;
}

.bookmarkCard__tools {
  position: absolute;
  top: 5px;
  right: 5px;
  display: flex;
  gap: 3px;
}

.bookmarkCard__tools button {
  display: inline-flex;
  padding: 4px;
  background: #000b;
  border: none;
  border-radius: 6px;
  color: #edffff;
  cursor: pointer;
}

.bookmarkCard__tools button:focus-visible {
  outline: 2px solid #7fd2ea;
}

@media (pointer: coarse) {
  .bookmarkCard__tools button {
    padding: 7px;
  }
}
</style>
