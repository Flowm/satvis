// An app-shell 200 is a missing asset; an unanswered request is not.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { BUILTIN_STAR_MAP, STAR_MAPS, starMapAvailable, starMapRecovery, starMapSources } from "./starMaps";

function stubFetch(answer: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(answer(String(input))));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** 206, because the probe asks for one byte; `response.ok` has to accept it. */
const imagePart = () => new Response(null, { status: 206, headers: { "content-type": "image/jpeg" } });
const imageWhole = () => new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } });
const missing = () => new Response(null, { status: 404 });
const appShell = () => new Response(null, { status: 200, headers: { "content-type": "text/html" } });

beforeEach(() => {
  // The probe memoises per module.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function freshModule() {
  return await import("./starMaps");
}

describe("starMapSources", () => {
  test("Tycho1K has no urls, because Cesium resolves its own", () => {
    expect(starMapSources("Tycho1K")).toBeUndefined();
  });

  test("an unknown name has no urls either", () => {
    expect(starMapSources("Nonsense")).toBeUndefined();
  });

  const optional = STAR_MAPS.filter((name) => starMapSources(name) !== undefined);

  test.each(optional)("%s names all six faces", (name) => {
    const sources = starMapSources(name);
    expect(sources && Object.keys(sources).toSorted()).toEqual(["negativeX", "negativeY", "negativeZ", "positiveX", "positiveY", "positiveZ"]);
    expect(new Set(Object.values(sources!)).size).toBe(6);
  });

  test.each(optional)("%s is served from the generated directory, not the submodule", (name) => {
    expect(starMapSources(name)!.positiveX).toContain("data/starmap/");
  });

  test("no two maps share a face url", () => {
    const urls = optional.flatMap((name) => Object.values(starMapSources(name)!));
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("every map is either builtin or has sources — no third state", () => {
    for (const name of STAR_MAPS) {
      expect(name === BUILTIN_STAR_MAP || starMapSources(name) !== undefined).toBe(true);
    }
  });
});

describe("starMapRecovery", () => {
  test("names the generator for the map the generator builds", () => {
    expect(starMapRecovery("DeepStar2K")).toBe("pnpm update-starmap");
  });

  test("the builtin has nothing to recover", () => {
    expect(starMapRecovery(BUILTIN_STAR_MAP)).toBeUndefined();
  });

  test("a hint exists for every map that can actually go missing", () => {
    for (const name of STAR_MAPS) {
      if (starMapSources(name) !== undefined) {
        expect(starMapRecovery(name)).toBeTruthy();
      }
    }
  });
});

describe("starMapAvailable", () => {
  test("the builtin needs no probe: it ships inside Cesium", async () => {
    const spy = stubFetch(missing);
    await expect(starMapAvailable(BUILTIN_STAR_MAP)).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  test("an unknown name is never available", async () => {
    stubFetch(imagePart);
    await expect(starMapAvailable("Nonsense")).resolves.toBe(false);
  });

  // The Cache API ignores non-GET requests, so a HEAD misses the service worker's cache offline.
  test("probes with a one-byte ranged GET, never a HEAD", async () => {
    const spy = stubFetch(imagePart);
    const { starMapAvailable: probe } = await freshModule();
    await probe("DeepStar2K");
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method ?? "GET").toBe("GET");
    expect((init?.headers as Record<string, string>)?.Range).toBe("bytes=0-0");
  });

  test("a partial image answer means present", async () => {
    stubFetch(imagePart);
    const { starMapAvailable: probe } = await freshModule();
    await expect(probe("DeepStar2K")).resolves.toBe(true);
  });

  // A cache hit, or a server that ignores Range, answers with the whole file.
  test("a whole image answer means present too", async () => {
    stubFetch(imageWhole);
    const { starMapAvailable: probe } = await freshModule();
    await expect(probe("DeepStar2K")).resolves.toBe(true);
  });

  test("a 404 means absent", async () => {
    stubFetch(missing);
    const { starMapAvailable: probe } = await freshModule();
    await expect(probe("DeepStar2K")).resolves.toBe(false);
  });

  test("a 200 that is not an image means absent — an SPA fallback is not the asset", async () => {
    stubFetch(appShell);
    const { starMapAvailable: probe } = await freshModule();
    await expect(probe("DeepStar2K")).resolves.toBe(false);
  });

  test("no answer at all means available: offline is not evidence of absence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const { starMapAvailable: probe } = await freshModule();
    await expect(probe("DeepStar2K")).resolves.toBe(true);
  });

  test("the answer is remembered rather than re-asked", async () => {
    const spy = stubFetch(imagePart);
    const { starMapAvailable: probe } = await freshModule();
    await Promise.all([probe("DeepStar2K"), probe("DeepStar2K"), probe("DeepStar2K")]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("availableStarMaps", () => {
  test("keeps STAR_MAPS order rather than probe completion order", async () => {
    // Delayed, so resolution order would put the unprobed builtin first.
    stubFetch(() => new Promise((r) => setTimeout(() => r(imagePart()), 5)));
    const { availableStarMaps: list } = await freshModule();
    await expect(list()).resolves.toEqual([...STAR_MAPS]);
  });

  test("drops what is missing and always keeps the builtin", async () => {
    stubFetch(missing);
    const { availableStarMaps: list } = await freshModule();
    await expect(list()).resolves.toEqual([BUILTIN_STAR_MAP]);
  });

  test("the group is never empty, whatever the probes say", async () => {
    stubFetch(appShell);
    const { availableStarMaps: list } = await freshModule();
    await expect(list()).resolves.toContain(BUILTIN_STAR_MAP);
  });

  // `--size 2048` or a half-finished run leaves only one cut.
  test("offers only the cut that exists when the generator built one size", async () => {
    stubFetch((url) => (url.includes("_1024_") ? missing() : imagePart()));
    const { availableStarMaps: list } = await freshModule();
    const names = await list();
    expect(names).toContain("DeepStar2K");
    expect(names).not.toContain("DeepStar1K");
    expect(names).toContain(BUILTIN_STAR_MAP);
  });
});

describe("the menu and the url vocabulary are deliberately different", () => {
  test("a map absent from the server stays a legal url value", async () => {
    stubFetch(missing);
    const { availableStarMaps: list, STAR_MAPS: all } = await freshModule();
    expect(await list()).not.toContain("DeepStar2K");
    // enumString in the store is built from STAR_MAPS, not from what is present.
    expect(all).toContain("DeepStar2K");
  });
});
