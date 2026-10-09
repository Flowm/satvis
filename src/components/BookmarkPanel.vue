<!-- The Bookmarks panel: demos, saved bookmarks and opened links as cards, the way back to the default view, and saving the scene. -->
<template>
  <div class="bookmarkPanel">
    <div class="bookmarkPanel__tabs" role="tablist" aria-label="Bookmarks">
      <button
        v-for="entry in TABS"
        :key="entry.key"
        type="button"
        role="tab"
        :aria-selected="tab === entry.key"
        :class="{ 'bookmarkPanel__tab--on': tab === entry.key }"
        @click="tab = entry.key"
      >
        {{ entry.label }}<span v-if="count(entry.key)" class="bookmarkPanel__count">{{ count(entry.key) }}</span>
      </button>
    </div>

    <div class="bookmarkPanel__grid" role="tabpanel">
      <bookmark-card
        v-for="bookmark in shown"
        :key="bookmark.id"
        :bookmark="bookmark"
        :summary="summary(bookmark)"
        :current="isCurrent(bookmark)"
        v-model:draft="draft"
        :renaming="renaming === bookmark.id"
        @open="open(bookmark)"
        @rename="startRename(bookmark)"
        @commit="commitRename"
        @cancel="renaming = undefined"
        @remove="onRemove(bookmark)"
        @keep="onKeep(bookmark)"
        @share="void onShare(bookmark)"
      />
      <p v-if="shown.length === 0" class="bookmarkPanel__empty">{{ EMPTY[tab] }}</p>
    </div>

    <footer class="bookmarkPanel__footer">
      <button type="button" :disabled="isDefault" @click="openDefault"><UIcon name="lucide:rotate-ccw" />Default view</button>
      <!-- While a name is open the button saves it, not a new bookmark. Pressing it keeps the focus
           in the field, or Safari, which focuses no clicked button, would end the edit first. -->
      <button v-if="renaming" type="button" class="bookmarkPanel__primary" data-saves-name @pointerdown.prevent @click="commitRename"><UIcon name="lucide:check" />Save</button>
      <!-- A scene saved already opens its name rather than saving it twice. -->
      <button v-else-if="savedCurrent" type="button" class="bookmarkPanel__primary" @click="showSaved(savedCurrent)"><UIcon name="lucide:bookmark-check" />Saved</button>
      <button v-else type="button" class="bookmarkPanel__primary" :disabled="isDefault || saving" @click="void onSave()">
        <UIcon name="lucide:bookmark-plus" />Save this view
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { useToast } from "@nuxt/ui/composables/useToast";
import { computed, ref } from "vue";

import { useBookmarks } from "../composables/useBookmarks";
import type { Bookmark } from "../modules/util/bookmarks";
import BookmarkCard from "./BookmarkCard.vue";

/** The kind of bookmark a tab lists. */
type Tab = "demo" | "saved" | "opened";

/** "Recent" on screen: opened links are the links recent visits started with. */
const TABS: { key: Tab; label: string }[] = [
  { key: "demo", label: "Demos" },
  { key: "saved", label: "Saved" },
  { key: "opened", label: "Recent" },
];

/** What an empty tab says. Demos are never empty. */
const EMPTY: Record<Tab, string> = {
  demo: "",
  saved: "Save this view to come back to it.",
  opened: "Links you open show up here.",
};

const { demos, saved, opened, isDefault, isCurrent, summary, open, link, openDefault, saveCurrent, rename, keep, remove, restore, forget } = useBookmarks();
const toast = useToast();

/** Opens on Saved for a visitor who has saved something. */
const tab = ref<Tab>(saved.value.length > 0 ? "saved" : "demo");
/** The open tab's bookmarks. */
const shown = computed(() => (tab.value === "demo" ? demos : tab.value === "saved" ? saved.value : opened.value));
/** The badge on a tab; demos have none. */
const count = (key: Tab): number => (key === "saved" ? saved.value.length : key === "opened" ? opened.value.length : 0);

/** The saved bookmark of the scene on screen, if there is one. */
const savedCurrent = computed(() => saved.value.find(isCurrent));

/** The bookmark whose name is being edited, and the name as typed so far. */
const renaming = ref<string>();
const draft = ref("");
/** A picture is being taken, which a second press must not repeat. */
const saving = ref(false);

/** Opens `bookmark`'s name for editing. */
function startRename(bookmark: Bookmark): void {
  draft.value = bookmark.name;
  renaming.value = bookmark.id;
}

/** Shows a saved bookmark with its name open. */
function showSaved(bookmark: Bookmark): void {
  tab.value = "saved";
  startRename(bookmark);
}

/** A blank name keeps the old one (the store's `rename`). */
function commitRename(): void {
  if (renaming.value !== undefined) {
    rename(renaming.value, draft.value);
    renaming.value = undefined;
  }
}

/** Saves under a name drawn from the scene, then offers to change it. */
async function onSave(): Promise<void> {
  saving.value = true;
  try {
    const bookmark = await saveCurrent();
    tab.value = "saved";
    startRename(bookmark);
  } finally {
    saving.value = false;
  }
}

/** Saves an opened link, keeping its name for the visitor to change. */
function onKeep(bookmark: Bookmark): void {
  const kept = keep(bookmark.id, bookmark.name);
  if (kept) {
    tab.value = "saved";
    startRename(kept);
  }
}

/**
 * The system's share sheet where the browser has one and the page may use it (not in an
 * iframe without `allow="web-share"`), the clipboard otherwise.
 */
async function onShare(bookmark: Bookmark): Promise<void> {
  const url = link(bookmark);
  if (navigator.canShare?.({ url })) {
    try {
      await navigator.share({ url });
      return;
    } catch (error) {
      // Dismissing the sheet rejects too.
      if ((error as DOMException).name === "AbortError") {
        return;
      }
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast.add({ title: "Link copied", description: bookmark.name, duration: 3000 });
  } catch {
    toast.add({ title: "Could not copy the link", description: url, color: "error" });
  }
}

/** Deleting a saved bookmark can be undone; forgetting an opened link needs no undo. */
function onRemove(bookmark: Bookmark): void {
  if (bookmark.kind === "opened") {
    forget(bookmark.id);
    return;
  }
  remove(bookmark.id);
  toast.add({
    title: `Deleted “${bookmark.name}”`,
    duration: 5000,
    actions: [{ label: "Undo", color: "neutral", variant: "outline", onClick: () => restore(bookmark) }],
  });
}
</script>

<style scoped>
.bookmarkPanel {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: min(420px, var(--toolbar-panel-max));
  max-height: calc(100dvh - 160px);
  padding: 0 8px 8px;
}

.bookmarkPanel__tabs {
  display: flex;
  flex: none;
  gap: 2px;
  padding: 2px;
  background: #1f2225;
  border-radius: 8px;
}

.bookmarkPanel__tabs button {
  flex: 1;
  padding: 5px 0;
  background: none;
  border: none;
  border-radius: 6px;
  color: #edffff;
  font-size: 13px;
  opacity: 0.7;
  cursor: pointer;
}

.bookmarkPanel__tabs .bookmarkPanel__tab--on {
  background: #464b50;
  opacity: 1;
}

.bookmarkPanel__tabs button:focus-visible {
  outline: 2px solid #7fd2ea;
  outline-offset: -2px;
}

.bookmarkPanel__count {
  margin-left: 5px;
  padding: 0 5px;
  background: #ffffff1f;
  border-radius: 8px;
  font-size: 11px;
}

/* Cards clip their corners, which lets auto rows shrink below their content instead of scrolling. */
.bookmarkPanel__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  grid-auto-rows: max-content;
  gap: 8px;
  min-height: 0;
  margin: 8px 0;
  overflow-y: auto;
}

.bookmarkPanel__empty {
  grid-column: 1 / -1;
  margin: 0;
  padding: 24px 8px;
  font-size: 12px;
  text-align: center;
  opacity: 0.6;
}

.bookmarkPanel__footer {
  display: flex;
  flex: none;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid #ffffff1f;
}

.bookmarkPanel__footer button {
  display: inline-flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 0;
  background: #464b50;
  border: none;
  border-radius: 6px;
  color: #edffff;
  font-size: 13px;
  cursor: pointer;
}

.bookmarkPanel__footer .bookmarkPanel__primary {
  background: #3d7f93;
}

.bookmarkPanel__footer button:disabled {
  cursor: default;
  opacity: 0.5;
}

.bookmarkPanel__footer button:focus-visible {
  outline: 2px solid #7fd2ea;
}
</style>
