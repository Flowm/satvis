<!-- The Bookmarks panel: featured and saved bookmarks and opened links as cards, the way back to the default view, and saving the scene. -->
<template>
  <div class="bookmarkPanel">
    <div class="bookmarkPanel__tabs" role="tablist" aria-label="Bookmarks">
      <button
        v-for="entry in tabs"
        :key="entry.key"
        type="button"
        role="tab"
        :aria-selected="tab === entry.key"
        :class="{ 'bookmarkPanel__tab--on': tab === entry.key }"
        @click="show(entry.key)"
      >
        {{ entry.label }}<span v-if="count(entry.key)" class="countBadge">{{ count(entry.key) }}</span>
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
        @open="onOpen(bookmark)"
        @rename="startRename(bookmark)"
        @commit="commitRename"
        @cancel="renaming = undefined"
        @remove="onRemove(bookmark)"
        @keep="onKeep(bookmark)"
        @share="void share(link(bookmark), bookmark.name)"
      />
      <p v-if="shown.length === 0" class="bookmarkPanel__empty">{{ EMPTY[tab] }}</p>
    </div>

    <footer class="bookmarkPanel__footer">
      <button type="button" :disabled="isDefault" @click="onOpenDefault"><UIcon name="lucide:rotate-ccw" />Default view</button>
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
import { computed, ref, watch } from "vue";

import { useBookmarks } from "@/composables/useBookmarks";
import type { Bookmark, BookmarkKind } from "@/modules/util/bookmarks";

import BookmarkCard from "./BookmarkCard.vue";

/** The kind of bookmark a tab lists. */
type Tab = BookmarkKind;

/** "Recent" on screen: opened links are the links recent visits started with. */
const TABS: { key: Tab; label: string }[] = [
  { key: "featured", label: "Featured" },
  { key: "saved", label: "Saved" },
  { key: "opened", label: "Recent" },
];

/** What an empty tab says. Featured is hidden rather than empty. */
const EMPTY: Record<Tab, string> = {
  featured: "",
  saved: "Save this view to come back to it.",
  opened: "Links you open show up here.",
};

const { featured, saved, opened, isDefault, isCurrent, summary, open, link, share, openDefault, saveCurrent, rename, keep, remove, restore, forget } = useBookmarks();
const toast = useToast();
const emit = defineEmits<{ opened: [] }>();

/** A preset that features nothing has no Featured tab. */
const tabs = computed(() => TABS.filter(({ key }) => key !== "featured" || featured.value.length > 0));
/** Saved for a visitor who has saved something, else Featured where the preset has any. */
const openingTab = (): Tab => (saved.value.length > 0 ? "saved" : featured.value.length > 0 ? "featured" : "opened");
const tab = ref<Tab>(openingTab());
/** Whether the visitor has moved off the opening tab, which the arriving group index then leaves alone. */
let moved = false;
// The preset's featured bookmarks arrive with the group index, which can be after the panel opened.
watch(
  () => featured.value.length > 0,
  () => {
    if (!moved) {
      tab.value = openingTab();
    }
  },
);
/** The open tab's bookmarks. */
const shown = computed(() => (tab.value === "featured" ? featured.value : tab.value === "saved" ? saved.value : opened.value));
/** The badge on a tab; Featured has none. */
const count = (key: Tab): number => (key === "saved" ? saved.value.length : key === "opened" ? opened.value.length : 0);

/** The saved bookmark of the scene on screen, if there is one. */
const savedCurrent = computed(() => saved.value.find(isCurrent));

/** The bookmark whose name is being edited, and the name as typed so far. */
const renaming = ref<string>();
const draft = ref("");
/** A picture is being taken, which a second press must not repeat. */
const saving = ref(false);

/** Opens `bookmark`, and the panel closes on the scene. */
function onOpen(bookmark: Bookmark): void {
  open(bookmark);
  emit("opened");
}

/** As `onOpen`, for the default view. */
function onOpenDefault(): void {
  openDefault();
  emit("opened");
}

/** Shows the `key` tab, for good: the arriving group index no longer changes it. */
function show(key: Tab): void {
  moved = true;
  tab.value = key;
}

/** Opens `bookmark`'s name for editing. */
function startRename(bookmark: Bookmark): void {
  draft.value = bookmark.name;
  renaming.value = bookmark.id;
}

/** Shows a saved bookmark with its name open. */
function showSaved(bookmark: Bookmark): void {
  show("saved");
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
    show("saved");
    startRename(bookmark);
  } finally {
    saving.value = false;
  }
}

/** Saves an opened link, keeping its name for the visitor to change. */
function onKeep(bookmark: Bookmark): void {
  const kept = keep(bookmark.id, bookmark.name);
  if (kept) {
    show("saved");
    startRename(kept);
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
  background: var(--panel-raised);
  border-radius: 8px;
}

.bookmarkPanel__tabs button {
  flex: 1;
  padding: 5px 0;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--panel-ink);
  font-size: 13px;
  opacity: 0.7;
  cursor: pointer;
}

.bookmarkPanel__tabs .bookmarkPanel__tab--on {
  background: var(--panel-selected);
  opacity: 1;
}

.bookmarkPanel__tabs button:focus-visible {
  outline: 2px solid var(--panel-accent);
  outline-offset: -2px;
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
  border-top: 1px solid var(--panel-hairline);
}

.bookmarkPanel__footer button {
  display: inline-flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 0;
  background: var(--panel-raised);
  border: none;
  border-radius: 6px;
  color: var(--panel-ink);
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
  outline: 2px solid var(--panel-accent);
}
</style>
