// GraphQL client for the worker's /api/graphql endpoint.
//
// The app already has a REST source (src/modules/util/gpSource.ts) for GP
// records. This client lets a component pull the same data through GraphQL,
// requesting only the fields it renders, in one call. Mirrors the probe-then-
// fetch pattern used elsewhere: if the worker answers with JSON we use the API
// base, otherwise we fall back to the static snapshot's group index so the UI
// still renders something offline.

export interface GpSatellite {
  name: string;
  line1?: string;
  line2?: string;
}

export interface GpGroup {
  name: string;
  updated?: string;
  count?: number;
  satellites: GpSatellite[];
}

export interface GpIndexEntry {
  name: string;
  updated?: string;
  count?: number;
}

export interface GraphqlResult {
  data?: {
    groups?: GpIndexEntry[];
    group?: GpGroup | null;
    satellite?: GpSatellite | null;
  };
  errors?: { message: string }[];
}

const API_URL = "/api/graphql";
const STATIC_INDEX_URL = "data/gp/index.json";

let apiAvailable: boolean | undefined;

// Probe once per session: a POST that the worker answers with JSON marks the
// GraphQL API as available; anything else (SPA HTML fallback, network error)
// means we run worker-less and should not spam a dead endpoint.
async function isApiAvailable(): Promise<boolean> {
  if (apiAvailable !== undefined) return apiAvailable;
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ groups { name } }" }),
    });
    const text = await response.text();
    apiAvailable = (() => {
      try {
        return typeof (JSON.parse(text) as { data?: unknown }).data === "object";
      } catch {
        return false;
      }
    })();
  } catch {
    apiAvailable = false;
  }
  return apiAvailable;
}

export async function graphqlRequest(query: string): Promise<GraphqlResult> {
  if (await isApiAvailable()) {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (response.ok) {
      return (await response.json()) as GraphqlResult;
    }
  }
  // Worker-less fallback: the static snapshot exposes the same group index.
  try {
    const response = await fetch(STATIC_INDEX_URL);
    if (response.ok) {
      const payload = (await response.json()) as { groups?: GpIndexEntry[] };
      return { data: { groups: payload.groups ?? [] } };
    }
  } catch {
    /* ignore, fall through to empty */
  }
  return { data: { groups: [] } };
}

// Test seam.
export function resetGraphqlProbe(): void {
  apiAvailable = undefined;
}
