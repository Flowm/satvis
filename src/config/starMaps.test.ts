// An app-shell 200 is a missing asset; an unanswered request is not.

import { afterEach, describe, expect, test, vi } from "vitest";

import { availableStarMaps, BUILTIN_STAR_MAP, STAR_MAPS, starMapRecovery, starMapSources } from "./starMaps";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

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
});

describe("availableStarMaps", () => {
  /** Whether a generated map is offered when its faces answer so. */
  async function offered(answer: () => Response): Promise<boolean> {
    stubFetch(answer);
    return (await availableStarMaps()).includes("DeepStar2K");
  }

  // The Cache API ignores non-GET requests, so a HEAD misses the service worker's cache offline.
  test("probes with a one-byte ranged GET, never a HEAD", async () => {
    const spy = stubFetch(imagePart);
    await availableStarMaps();
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method ?? "GET").toBe("GET");
    expect((init?.headers as Record<string, string>)?.Range).toBe("bytes=0-0");
  });

  test("a partial image answer means present", async () => {
    expect(await offered(imagePart)).toBe(true);
  });

  // A cache hit, or a server that ignores Range, answers with the whole file.
  test("a whole image answer means present too", async () => {
    expect(await offered(imageWhole)).toBe(true);
  });

  test("a 404 means absent", async () => {
    expect(await offered(missing)).toBe(false);
  });

  test("a 200 that is not an image means absent — an SPA fallback is not the asset", async () => {
    expect(await offered(appShell)).toBe(false);
  });

  test("no answer at all means present: offline is not evidence of absence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    expect(await availableStarMaps()).toContain("DeepStar2K");
  });

  test("keeps STAR_MAPS order rather than probe completion order", async () => {
    // Delayed, so resolution order would put the unprobed builtin first.
    stubFetch(() => new Promise((r) => setTimeout(() => r(imagePart()), 5)));
    await expect(availableStarMaps()).resolves.toEqual([...STAR_MAPS]);
  });

  test("keeps the builtin without probing it: it ships inside Cesium", async () => {
    const spy = stubFetch(missing);
    await expect(availableStarMaps()).resolves.toEqual([BUILTIN_STAR_MAP]);
    expect(spy.mock.calls.every(([url]) => String(url).includes("data/starmap/"))).toBe(true);
  });

  // `--size 2048` or a half-finished run leaves only one cut.
  test("offers only the cut that exists when the generator built one size", async () => {
    stubFetch((url) => (url.includes("_1024_") ? missing() : imagePart()));
    const names = await availableStarMaps();
    expect(names).toContain("DeepStar2K");
    expect(names).not.toContain("DeepStar1K");
    expect(names).toContain(BUILTIN_STAR_MAP);
  });
});

describe("the menu and the url vocabulary are deliberately different", () => {
  test("a map absent from the server stays a legal url value", async () => {
    stubFetch(missing);
    expect(await availableStarMaps()).not.toContain("DeepStar2K");
    // enumString in the store is built from STAR_MAPS, not from what is present.
    expect(STAR_MAPS).toContain("DeepStar2K");
  });
});
