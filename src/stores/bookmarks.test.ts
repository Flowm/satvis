import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick } from "vue";

import { useBookmarkStore } from "./bookmarks";

/** A `localStorage` that can be made to run out of room. */
function fakeStorage() {
  const items = new Map<string, string>();
  let quota = Infinity;
  return {
    items,
    setQuota: (bytes: number) => (quota = bytes),
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > quota) {
        throw new DOMException("full", "QuotaExceededError");
      }
      items.set(key, value);
    },
    removeItem: (key: string) => items.delete(key),
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal("localStorage", storage);
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bookmarks store", () => {
  test("saved bookmarks outlive the page", async () => {
    useBookmarkStore().save("Home", { path: "/", query: { tags: "GNSS" } });
    await nextTick();

    setActivePinia(createPinia());
    expect(useBookmarkStore().saved).toMatchObject([{ name: "Home", path: "/", query: { tags: "GNSS" } }]);
  });

  test("keeping an opened link moves it to the saved ones", () => {
    const store = useBookmarkStore();
    const link = store.recordOpened("Starlink satellites", { path: "/", query: { tags: "Starlink" } });
    store.setThumbnail(link.id, "data:image/webp;base64,AA");

    store.keep(link.id, "Shells");
    expect(store.opened).toEqual([]);
    expect(store.saved).toMatchObject([{ kind: "saved", name: "Shells", query: { tags: "Starlink" }, thumbnail: "data:image/webp;base64,AA" }]);
  });

  test("a link kept before its picture arrives still gets it", () => {
    const store = useBookmarkStore();
    const link = store.recordOpened("Starlink satellites", { path: "/", query: { tags: "Starlink" } });
    store.keep(link.id, "Shells");
    store.setThumbnail(link.id, "data:image/webp;base64,AA");
    expect(store.saved[0]!.thumbnail).toBe("data:image/webp;base64,AA");
  });

  test("saving a scene takes its link off the recent ones", () => {
    const store = useBookmarkStore();
    store.recordOpened("Starlink satellites", { path: "/", query: { tags: "Starlink" } });
    store.recordOpened("GNSS satellites", { path: "/", query: { tags: "GNSS" } });
    store.save("Shells", { path: "/", query: { tags: "Starlink" } });
    expect(store.opened.map((link) => link.query.tags)).toEqual(["GNSS"]);
  });

  test("a deleted bookmark comes back in its place", () => {
    const store = useBookmarkStore();
    vi.spyOn(Date, "now").mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValueOnce(3);
    const [a, b, c] = [store.save("a", { path: "/", query: {} }), store.save("b", { path: "/", query: {} }), store.save("c", { path: "/", query: {} })];
    store.remove(b.id);
    store.restore(b);
    expect(store.saved.map((bookmark) => bookmark.id)).toEqual([c.id, b.id, a.id]);
  });

  test("a blank name keeps the old one", () => {
    const store = useBookmarkStore();
    const bookmark = store.save("Home", { path: "/", query: {} });
    store.rename(bookmark.id, "  ");
    expect(store.saved[0]!.name).toBe("Home");
    store.rename(bookmark.id, " Away ");
    expect(store.saved[0]!.name).toBe("Away");
  });

  test("a full storage drops the pictures and keeps the bookmarks", async () => {
    const store = useBookmarkStore();
    storage.setQuota(200);
    store.save("Home", { path: "/", query: { tags: "GNSS" } }, `data:image/webp;base64,${"A".repeat(500)}`);
    await nextTick();
    const stored = JSON.parse(storage.items.get("satvis:bookmarks:saved")!) as object[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toHaveProperty("thumbnail");
  });

  test("works without storage", () => {
    vi.stubGlobal("localStorage", undefined);
    setActivePinia(createPinia());
    const store = useBookmarkStore();
    store.save("Home", { path: "/", query: {} });
    expect(store.saved).toHaveLength(1);
  });
});
