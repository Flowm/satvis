// Bookmarks against the router and the globe: opening one, saving the scene, and
// recording the link a visit started with (docs/adr/0011-bookmarks.md).

import { computed, reactive } from "vue";
import { type LocationQuery, type Router, useRouter } from "vue-router";

import { DEMO_BOOKMARKS } from "../config/bookmarks";
import { presetNameOf, resolvePreset } from "../config/presets";
import type { CesiumController } from "../modules/CesiumController";
import { type Bookmark, type BookmarkSummary, defaultName, sameQuery, summarize, withoutTime } from "../modules/util/bookmarks";
import { DeviceDetect } from "../modules/util/DeviceDetect";
import { captureThumbnail, sceneSettled } from "../modules/util/thumbnail";
import type { Query } from "../modules/util/urlCodec";
import { syncedParams, syncedQuery, urlHydrated } from "../modules/util/urlSync";
import { useBookmarkStore } from "../stores/bookmarks";
import { useController } from "./useController";

/** Per preset name, its defaults, which a bookmark's query is relative to. Filled as cards ask. */
const presetDefaults = reactive(new Map<string, Query>());

function defaultsFor(path: string): Query {
  const preset = presetNameOf(path);
  if (!presetDefaults.has(preset)) {
    presetDefaults.set(preset, {});
    void resolvePreset(path).then(({ defaults }) => presetDefaults.set(preset, defaults));
  }
  return presetDefaults.get(preset)!;
}

/** The parameters of `query` that belong to no store, such as `framems`. A bookmark keeps them as they are. */
function foreign(query: LocationQuery): LocationQuery {
  const owned = syncedParams();
  return Object.fromEntries(Object.entries(query).filter(([param]) => !owned.has(param)));
}

export function useBookmarks() {
  const cc = useController();
  const router = useRouter();
  const store = useBookmarkStore();

  const route = computed(() => router.currentRoute.value);
  /** The scene's own parameters, as the url states them. */
  const current = computed<Query>(() => {
    const owned = syncedParams();
    return Object.fromEntries(Object.entries(route.value.query).flatMap(([param, value]) => (owned.has(param) && typeof value === "string" ? [[param, value]] : [])));
  });
  const isDefault = computed(() => Object.keys(current.value).length === 0);

  const isCurrent = (bookmark: Bookmark): boolean => presetNameOf(bookmark.path) === presetNameOf(route.value.path) && sameQuery(bookmark.query, current.value);

  const summary = (bookmark: Bookmark): BookmarkSummary => summarize(bookmark.query, defaultsFor(bookmark.path));

  /**
   * Same preset: a push, so Back returns. Another preset: a page load, because the url
   * sync reads the route's preset defaults only once, at startup.
   */
  function open(bookmark: Bookmark): void {
    if (presetNameOf(bookmark.path) === presetNameOf(route.value.path)) {
      // A paused or fast clock stays off `time` for its first minute, so a url without
      // one would leave it paused or fast: a bookmark without `time` is live.
      if (bookmark.query.time === undefined) {
        cc.goLive();
      }
      void router.push({ query: { ...foreign(route.value.query), ...bookmark.query } });
    } else {
      window.location.assign(router.resolve({ path: bookmark.path, query: bookmark.query }).href);
    }
  }

  /** The route's preset as it opens: every scene parameter dropped, the clock live. */
  function openDefault(): void {
    cc.goLive();
    void router.push({ query: foreign(route.value.query) });
  }

  /** Saves the scene on screen, named after what it shows. */
  async function saveCurrent(): Promise<Bookmark> {
    const thumbnail = await captureThumbnail(cc.viewer.scene);
    const name = defaultName(summarize(current.value, defaultsFor(route.value.path)));
    return store.save(name, route.value.path, current.value, thumbnail);
  }

  return { demos: DEMO_BOOKMARKS, saved: computed(() => store.saved), opened: computed(() => store.opened), isDefault, isCurrent, summary, open, openDefault, saveCurrent, store };
}

/**
 * Records the link this visit started with, and photographs it once the globe has loaded.
 * A reload, Back or Forward reopens the visitor's own scene, and an embedded page is
 * someone else's, so none of them count; nor does a link already among the bookmarks.
 */
export async function recordOpenedLink(cc: CesiumController, router: Router): Promise<void> {
  const navigation = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (DeviceDetect.inIframe() || navigation?.type === "reload" || navigation?.type === "back_forward") {
    return;
  }
  await urlHydrated();
  const query = syncedQuery();
  const path = router.currentRoute.value.path;
  const store = useBookmarkStore();
  const known = [...DEMO_BOOKMARKS, ...store.saved].some((bookmark) => presetNameOf(bookmark.path) === presetNameOf(path) && sameQuery(bookmark.query, query));
  if (Object.keys(query).length === 0 || known) {
    return;
  }
  const { defaults } = await resolvePreset(path);
  const link = store.recordOpened(defaultName(summarize(query, defaults)), path, query);

  await sceneSettled(cc.viewer.scene, { minMs: 3000, maxMs: 20_000, ready: () => !cc.sats.building && (!cc.skyView.active || cc.skyView.settled) });
  // A visitor who moved on would leave a picture of something else.
  if (!sameQuery(withoutTime(syncedQuery()), withoutTime(query))) {
    return;
  }
  const thumbnail = await captureThumbnail(cc.viewer.scene);
  if (thumbnail) {
    store.setThumbnail(link.id, thumbnail);
  }
}
