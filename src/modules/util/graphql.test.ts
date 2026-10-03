import { afterEach, describe, expect, test, vi } from "vitest";

import { graphqlRequest, resetGraphqlProbe } from "./graphql";

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
  "/api/graphql": json({ data: { groups: [{ name: "weather", count: 2 }] } }),
  "data/gp/index.json": json({ groups: [{ name: "static", count: 1 }] }),
};

const STATIC_ONLY_ROUTES: RouteMap = {
  // The worker probe gets HTML (SPA fallback), so the client must fall back.
  "/api/graphql": () => new Response("<!doctype html><html></html>", { status: 200, headers: { "Content-Type": "text/html" } }),
  "data/gp/index.json": json({ groups: [{ name: "static", count: 1 }] }),
};

afterEach(() => {
  resetGraphqlProbe();
  vi.unstubAllGlobals();
});

describe("graphqlRequest", () => {
  test("uses the live worker when it answers JSON", async () => {
    installFetch(WORKER_ROUTES);
    const result = await graphqlRequest("{ groups { name } }");
    expect(result.data?.groups).toEqual([{ name: "weather", count: 2 }]);
  });

  test("falls back to the static snapshot when the worker is absent", async () => {
    installFetch(STATIC_ONLY_ROUTES);
    const result = await graphqlRequest("{ groups { name } }");
    expect(result.data?.groups).toEqual([{ name: "static", count: 1 }]);
  });

  test("returns an empty groups list on total failure", async () => {
    installFetch({});
    const result = await graphqlRequest("{ groups { name } }");
    expect(result.data?.groups).toEqual([]);
  });
});
