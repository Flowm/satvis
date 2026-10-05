import { afterEach, describe, expect, test, vi } from "vitest";

import { fetchGpGroup, fetchGpIndex, resetGpSource } from "./gpSource";

type RouteMap = Record<string, () => Response>;

function json(body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function installFetch(routes: RouteMap): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const route = routes[url];
      if (!route) {
        return new Response("Not Found", { status: 404 });
      }
      return route();
    }),
  );
  return requested;
}

const WORKER_ROUTES: RouteMap = {
  "/api/groups.json": json({ updated: "", groups: [{ name: "weather", count: 2 }] }),
};

const STATIC_ROUTES: RouteMap = {
  "data/gp/index.json": json({ updated: "", groups: [{ name: "weather", count: 1 }] }),
};

afterEach(() => {
  resetGpSource();
  vi.unstubAllGlobals();
});

describe("GpSource probe", () => {
  test("uses the worker API when the probe answers with JSON", async () => {
    const requested = installFetch({
      ...WORKER_ROUTES,
      "/api/gp/weather.json": () => new Response("[]"),
    });
    expect((await fetchGpIndex()).groups).toEqual([{ name: "weather", count: 2 }]);
    await fetchGpGroup("weather");
    expect(requested).toContain("/api/gp/weather.json");
  });

  test("falls back to the static snapshot when the probe fails", async () => {
    const requested = installFetch({
      ...STATIC_ROUTES,
      "data/gp/weather.json": () => new Response("[]"),
    });
    expect((await fetchGpIndex()).groups).toEqual([{ name: "weather", count: 1 }]);
    await fetchGpGroup("weather");
    expect(requested).toContain("data/gp/weather.json");
    expect(requested).not.toContain("/api/gp/weather.json");
  });

  test("treats an HTML probe answer (worker-less SPA fallthrough) as no worker", async () => {
    installFetch({
      "/api/groups.json": () => new Response("<!doctype html><html></html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      ...STATIC_ROUTES,
    });
    expect((await fetchGpIndex()).groups).toEqual([{ name: "weather", count: 1 }]);
  });

  test("reads each group's tags and the presets", async () => {
    installFetch({
      "/api/groups.json": json({
        updated: "",
        groups: [{ name: "weather", count: 2, tags: ["Weather"] }],
        presets: { default: { title: "Satvis", defaults: { tags: "Weather" }, groups: [{ name: "weather" }, { name: "starlink", searchOnly: true }] } },
      }),
    });
    expect(await fetchGpIndex()).toEqual({
      groups: [{ name: "weather", count: 2, tags: ["Weather"] }],
      presets: { default: { title: "Satvis", defaults: { tags: "Weather" }, groups: [{ name: "weather" }, { name: "starlink", searchOnly: true }] } },
    });
  });

  // An old or malformed index reads as one without tags and presets, rather than failing the probe.
  test("drops tags and presets of the wrong shape", async () => {
    installFetch({
      "/api/groups.json": json({
        updated: "",
        groups: [{ name: "weather", tags: "Weather" }],
        presets: { default: { groups: "weather" }, ot: { defaults: { tags: "OT", fps: true }, groups: [{ name: "ot" }, { searchOnly: true }] } },
      }),
    });
    expect(await fetchGpIndex()).toEqual({
      groups: [{ name: "weather" }],
      presets: { ot: { defaults: { tags: "OT" }, groups: [{ name: "ot" }] } },
    });
  });

  test("probes only once per session", async () => {
    const requested = installFetch(WORKER_ROUTES);
    await fetchGpIndex();
    await fetchGpGroup("weather").catch(() => undefined);
    await fetchGpGroup("stations").catch(() => undefined);
    expect(requested.filter((url) => url === "/api/groups.json")).toHaveLength(1);
  });
});

describe("fetchGpGroup", () => {
  test("retries a failed API group against the static snapshot", async () => {
    installFetch({
      ...WORKER_ROUTES,
      "/api/gp/weather.json": () => new Response("KV miss", { status: 404 }),
      "data/gp/weather.json": () => new Response('[{"OBJECT_NAME":"METEO-1","NORAD_CAT_ID":1}]'),
    });
    const payload = await fetchGpGroup("weather");
    expect(JSON.parse(payload)).toHaveLength(1);
  });

  test("passes explicit URL sources through without a fallback", async () => {
    const requested = installFetch({
      ...WORKER_ROUTES,
      "data/tle/custom.txt": () => new Response("CUSTOM\n1 ...\n2 ..."),
    });
    const payload = await fetchGpGroup("data/tle/custom.txt");
    expect(payload).toContain("CUSTOM");
    expect(requested).not.toContain("/api/gp/data/tle/custom.txt.json");
  });

  test("rethrows when both the API and the static snapshot fail", async () => {
    installFetch({
      ...WORKER_ROUTES,
      "/api/gp/weather.json": () => new Response("boom", { status: 500 }),
      "data/gp/weather.json": () => new Response("missing", { status: 404 }),
    });
    await expect(fetchGpGroup("weather")).rejects.toThrow();
  });
});
