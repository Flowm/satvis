// The adapter's own seam: what reaches the router's query, given store state.
// Foreign-parameter handling lives here rather than in the codec because only
// the router's LocationQuery can express a valueless or repeated parameter.
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp, markRaw } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

import { useCesiumStore } from "../../stores/cesium";
import { useSatStore } from "../../stores/sat";
import type { Query } from "./urlCodec";
import piniaUrlSync from "./urlSync";

// Writes reach the url through router.push/replace, which are async.
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function mount(initial: string, presetDefaults: Query = {}): Promise<{ router: Router }> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: {} }] });
  const pinia = createPinia();
  pinia.use(({ store }) => {
    store.router = markRaw(router);
    store.presetDefaults = markRaw(Promise.resolve(presetDefaults));
  });
  pinia.use(piniaUrlSync);
  createApp({}).use(pinia);
  setActivePinia(pinia);

  await router.replace(initial);
  useSatStore();
  useCesiumStore();
  await router.isReady();
  await flush();
  return { router };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("foreign parameters", () => {
  test("a valueless parameter survives a rebuild", async () => {
    const { router } = await mount("/?embed&tags=Weather");
    useSatStore().setActivation({ enabledTags: ["GNSS"] });
    await flush();
    expect("embed" in router.currentRoute.value.query).toBe(true);
    expect(router.currentRoute.value.query.tags).toBe("GNSS");
  });

  test("a repeated parameter keeps every value", async () => {
    const { router } = await mount("/?utm=a&utm=b");
    useSatStore().setActivation({ enabledTags: ["GNSS"] });
    await flush();
    expect(router.currentRoute.value.query.utm).toEqual(["a", "b"]);
  });

  test("an ordinary foreign parameter is untouched", async () => {
    const { router } = await mount("/?utm_source=x");
    useSatStore().setActivation({ enabledTags: ["GNSS"] });
    await flush();
    expect(router.currentRoute.value.query.utm_source).toBe("x");
  });
});

describe("preset defaults", () => {
  test("apply when the url says nothing", async () => {
    const { router } = await mount("/", { tags: "OT", elements: "Point,Orbit", overpass: "swath", layers: "VersaTiles" });
    expect(useSatStore().enabledTags).toEqual(["OT"]);
    expect(useSatStore().enabledComponents).toEqual(["Point", "Orbit"]);
    expect(useSatStore().overpassMode).toBe("swath");
    expect(useCesiumStore().layers).toEqual(["VersaTiles"]);
    expect(router.currentRoute.value.query).toEqual({});
  });

  test("give way to the url, which then states only what differs from them", async () => {
    const { router } = await mount("/?tags=GNSS&overpass=swath", { tags: "OT", overpass: "swath" });
    expect(useSatStore().enabledTags).toEqual(["GNSS"]);
    expect(router.currentRoute.value.query).toEqual({ tags: "GNSS" });

    useSatStore().setActivation({ enabledTags: ["OT"] });
    await flush();
    expect(router.currentRoute.value.query).toEqual({});
  });

  // The defaults are shared with clients whose vocabularies differ.
  test("that this client cannot use are ignored", async () => {
    const { router } = await mount("/", { terrain: "Garbage", someday: "1", tags: "OT" });
    expect(useCesiumStore().terrainProvider).toBe("None");
    expect(useSatStore().enabledTags).toEqual(["OT"]);
    expect(router.currentRoute.value.query).toEqual({});
  });
});

describe("owned parameters", () => {
  test("an invalid value is dropped and the state keeps its default", async () => {
    const { router } = await mount("/?terrain=Garbage");
    expect(useCesiumStore().terrainProvider).toBe("None");
    expect("terrain" in router.currentRoute.value.query).toBe(false);
  });

  // The one selection that can be armed for a view mode the url is not also
  // asking for, so it has to survive being currently inapplicable.
  test("a surface model that cannot apply here is still carried", async () => {
    const { router } = await mount("/?surface=GooglePhotorealistic");
    expect(useCesiumStore().surfaceModel).toBe("GooglePhotorealistic");
    expect(router.currentRoute.value.query.surface).toBe("GooglePhotorealistic");
  });

  test("an invalid surface model is dropped and the state keeps its default", async () => {
    const { router } = await mount("/?surface=Bogus");
    expect(useCesiumStore().surfaceModel).toBe("None");
    expect("surface" in router.currentRoute.value.query).toBe(false);
  });

  test("state that is not synced never reaches the url", async () => {
    const { router } = await mount("/");
    const before = router.currentRoute.value.fullPath;
    useCesiumStore().pickMode = true;
    useSatStore().catalogRevision += 1;
    await flush();
    expect(router.currentRoute.value.fullPath).toBe(before);
  });
});
