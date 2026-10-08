import { defineStore } from "pinia";
import { ref, watch } from "vue";

import { type Bookmark, type BookmarkKind, parseBookmarks, sameQuery, withOpened } from "../modules/util/bookmarks";

/** Per browser, not in the url: a bookmark is a link to a scene, not part of one (docs/adr/0011-bookmarks.md). */
const STORAGE_KEY: Record<Exclude<BookmarkKind, "demo">, string> = {
  saved: "satvis:bookmarks:saved",
  opened: "satvis:bookmarks:opened",
};

/** Private windows and blocked site data throw on access, so storage is optional. */
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function load(kind: keyof typeof STORAGE_KEY): Bookmark[] {
  try {
    return parseBookmarks(storage()?.getItem(STORAGE_KEY[kind]) ?? null, kind);
  } catch {
    return [];
  }
}

/** A full quota drops the pictures before the bookmarks. */
function store(kind: keyof typeof STORAGE_KEY, bookmarks: readonly Bookmark[]): void {
  const target = storage();
  if (!target) {
    return;
  }
  try {
    target.setItem(STORAGE_KEY[kind], JSON.stringify(bookmarks));
  } catch {
    try {
      target.setItem(STORAGE_KEY[kind], JSON.stringify(bookmarks.map(({ thumbnail: _thumbnail, ...rest }) => rest)));
    } catch (error) {
      console.warn(`Could not store the ${kind} bookmarks`, error);
    }
  }
}

let nextId = 0;
const newId = (kind: BookmarkKind): string => `${kind}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;

export const useBookmarkStore = defineStore("bookmarks", () => {
  /** Newest first. */
  const saved = ref<Bookmark[]>(load("saved"));
  /** Newest first, at most `OPENED_LIMIT`. */
  const opened = ref<Bookmark[]>(load("opened"));

  watch(saved, (bookmarks) => store("saved", bookmarks), { deep: true });
  watch(opened, (bookmarks) => store("opened", bookmarks), { deep: true });

  // Another tab's change arrives as a storage event. Writing the same value back fires none, so tabs do not echo.
  globalThis.addEventListener?.("storage", (event: StorageEvent) => {
    if (event.key === STORAGE_KEY.saved) {
      saved.value = load("saved");
    } else if (event.key === STORAGE_KEY.opened) {
      opened.value = load("opened");
    }
  });

  /** Saves a scene under `name`, and returns the bookmark. */
  function save(name: string, path: string, query: Bookmark["query"], thumbnail?: string): Bookmark {
    const bookmark: Bookmark = { id: newId("saved"), kind: "saved", name, path, query: { ...query }, thumbnail, at: Date.now() };
    saved.value = [bookmark, ...saved.value];
    // Saved, a link is no longer only a recent one.
    opened.value = opened.value.filter((link) => link.path !== path || !sameQuery(link.query, query));
    return bookmark;
  }

  /** Records the link a visit started with. */
  function recordOpened(name: string, path: string, query: Bookmark["query"]): Bookmark {
    const bookmark: Bookmark = { id: newId("opened"), kind: "opened", name, path, query: { ...query }, at: Date.now() };
    opened.value = withOpened(opened.value, bookmark);
    return bookmark;
  }

  /** Saves an opened link under `name`, keeping its id: its picture may still be on the way. */
  function keep(id: string, name: string): Bookmark | undefined {
    const link = opened.value.find((bookmark) => bookmark.id === id);
    if (!link) {
      return undefined;
    }
    forget(id);
    const bookmark: Bookmark = { ...link, kind: "saved", name, at: Date.now() };
    saved.value = [bookmark, ...saved.value];
    return bookmark;
  }

  /** A blank name keeps the old one. */
  function rename(id: string, name: string): void {
    const bookmark = saved.value.find((candidate) => candidate.id === id);
    if (bookmark && name.trim()) {
      bookmark.name = name.trim();
    }
  }

  function setThumbnail(id: string, thumbnail: string): void {
    const bookmark = [...saved.value, ...opened.value].find((candidate) => candidate.id === id);
    if (bookmark) {
      bookmark.thumbnail = thumbnail;
    }
  }

  /** Deletes a saved bookmark. */
  function remove(id: string): void {
    saved.value = saved.value.filter((bookmark) => bookmark.id !== id);
  }

  /** Puts a deleted bookmark back where its age places it. */
  function restore(bookmark: Bookmark): void {
    if (saved.value.some((candidate) => candidate.id === bookmark.id)) {
      return;
    }
    saved.value = [...saved.value, bookmark].toSorted((a, b) => b.at - a.at);
  }

  /** Takes a link off the opened list. */
  function forget(id: string): void {
    opened.value = opened.value.filter((bookmark) => bookmark.id !== id);
  }

  return { saved, opened, save, recordOpened, keep, rename, setThumbnail, remove, restore, forget };
});
