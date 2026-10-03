// Fetch-handler routing for the GP data API.

import { coerceIndex } from "./evaluate.ts";
import { ingestAll, type IngestSource, refreshAll } from "./refresh.ts";
import { GP_INDEX_KEY, GP_KEY_PREFIX, type GroupWriteMetadata } from "./store.ts";
import { handleGraphql } from "./graphql.ts";

const GROUP_NAME_RE = /^[a-zA-Z0-9_-]+$/;
// Cooldown for POST /api/refresh: within this window of the last refresh (manual
// OR cron) the endpoint will not re-hit CelesTrak. A second line of defence
// behind the bearer token, and short enough for iterative debugging.
const REFRESH_COOLDOWN_MS = 60_000;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

function notFound(): Response {
  return jsonResponse({ error: "Not Found" }, { status: 404 });
}

function badRequest(reason: string): Response {
  return jsonResponse({ error: reason }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

// Bearer-token gate for the two write endpoints. Returns the rejection to send,
// or null when the caller is authorized.
function rejectUnauthorized(request: Request, env: Env): Response | null {
  // Secrets live outside wrangler.jsonc, so `wrangler types` cannot see this one.
  // An unset secret disables the endpoint rather than leaving it open.
  const expected = (env as Env & { REFRESH_TOKEN?: string }).REFRESH_TOKEN;
  if (!expected) {
    return jsonResponse({ error: "Refresh is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (request.headers.get("Authorization") !== `Bearer ${expected}`) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}

// GET /api/gp/<group>.json — serve a group's records from KV with caching
// headers and conditional-request (If-None-Match -> 304) support.
async function handleGroup(name: string, request: Request, env: Env): Promise<Response> {
  if (!GROUP_NAME_RE.test(name)) {
    return notFound();
  }
  const { value, metadata } = await env.GP_KV.getWithMetadata<GroupWriteMetadata>(GP_KEY_PREFIX + name, {
    type: "text",
    cacheTtl: 300,
  });
  if (value === null) {
    return notFound();
  }

  const updated = metadata?.updated;
  const updatedMs = updated ? Date.parse(updated) : Date.now();
  const etag = `W/"${name}-${updatedMs}"`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300",
    ETag: etag,
    "Last-Modified": new Date(updatedMs).toUTCString(),
  };

  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(value, { headers });
}

async function handleIndex(env: Env): Promise<Response> {
  const index = await env.GP_KV.get(GP_INDEX_KEY, "text");
  if (index === null) {
    return jsonResponse({ updated: "", groups: [] });
  }
  return new Response(index, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

// POST /api/refresh — run the same refresh as the cron (fetch every source,
// evaluate, write KV) and return a per-source diagnostic report. Needs
// `Authorization: Bearer <REFRESH_TOKEN>`: one run pulls ~7 MB from CelesTrak,
// which firewalls by IP (250 MB/day) — and a Worker's egress IP is shared with
// other Cloudflare tenants, so an open trigger risks a block that stalls the cron
// for everyone. Also rate-limited: within REFRESH_COOLDOWN_MS of the last refresh
// it does NOT re-fetch, instead returning the cached index (errors included) with
// 429 so a caller keeps visibility without spending the budget. Whatever it does
// fetch is persisted, so — unlike a read-only probe — it never wastes a download.
// Its diagnostics matter most run against the deployed Worker, where failures
// like the 522s an IP block produces reproduce (they never do from a laptop).
async function handleRefresh(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const rejection = rejectUnauthorized(request, env);
  if (rejection) {
    return rejection;
  }

  const previous = coerceIndex(await env.GP_KV.get(GP_INDEX_KEY, "json"));
  const sinceMs = Date.now() - Date.parse(previous.updated);
  if (Number.isFinite(sinceMs) && sinceMs < REFRESH_COOLDOWN_MS) {
    const retryAfterMs = REFRESH_COOLDOWN_MS - sinceMs;
    return jsonResponse(
      { refreshed: false, reason: "cooldown", updatedAt: previous.updated, retryAfterMs, groups: previous.groups },
      { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)), "Cache-Control": "no-store" } },
    );
  }

  const report = await refreshAll(env);
  return jsonResponse(
    {
      refreshed: true,
      updatedAt: report.index.updated,
      durationMs: report.durationMs,
      written: report.written,
      skipped: report.skipped,
      sources: report.sources,
      groups: report.index.groups,
      satcat: report.index.satcat,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// Shape-check a posted ingest bundle. Returns the sources, or a string naming
// the first problem for the 400. Deliberately strict: a malformed bundle must
// fail loudly here rather than reach the pipeline as a wave of empty sources,
// which would read as an upstream outage.
function parseIngestBundle(raw: unknown): IngestSource[] | string {
  if (raw === null || typeof raw !== "object") {
    return "body must be a JSON object";
  }
  const sources = (raw as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) {
    return "body.sources must be an array";
  }
  if (sources.length === 0) {
    return "body.sources is empty";
  }
  const parsed: IngestSource[] = [];
  for (let i = 0; i < sources.length; i++) {
    const entry = sources[i] as Record<string, unknown> | null;
    if (entry === null || typeof entry !== "object") {
      return `body.sources[${i}] must be an object`;
    }
    const { key, url, status, body, error, validator } = entry;
    if (typeof key !== "string" || typeof url !== "string") {
      return `body.sources[${i}] needs string key and url`;
    }
    if (status !== undefined && typeof status !== "number") {
      return `body.sources[${i}].status must be a number`;
    }
    if (body !== undefined && typeof body !== "string") {
      return `body.sources[${i}].body must be a string`;
    }
    if (error !== undefined && typeof error !== "string") {
      return `body.sources[${i}].error must be a string`;
    }
    if (validator !== undefined && typeof validator !== "string") {
      return `body.sources[${i}].validator must be a string`;
    }
    // A 304 legitimately carries neither: it says the caller's conditional
    // request matched, so the stored value already is the payload.
    if (body === undefined && error === undefined && status !== 304) {
      return `body.sources[${i}] needs either body or error`;
    }
    parsed.push({ key, url, status, body, error, validator });
  }
  return parsed;
}

// POST /api/ingest — run the normal refresh against payloads the caller already
// downloaded, instead of fetching them here. Same bearer token as /api/refresh.
//
// The Worker keeps everything except the download: evaluation, enrichment,
// last-known-good and the index are the cron's code path unchanged (see
// bundleFetch). CelesTrak firewalls Cloudflare's shared Worker egress, so the
// bytes have to be fetched elsewhere — worker/scripts/push-gp.mjs is the client.
//
// No cooldown, unlike /api/refresh: that window exists to protect CelesTrak's
// per-IP download budget, and an ingest spends none of it. The token is the only
// gate it needs.
async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST" } });
  }

  const rejection = rejectUnauthorized(request, env);
  if (rejection) {
    return rejection;
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }
  const sources = parseIngestBundle(raw);
  if (typeof sources === "string") {
    return badRequest(sources);
  }

  console.log(`gp ingest: ${sources.length} source(s) posted`);
  const report = await ingestAll(env, sources);
  return jsonResponse(
    {
      ingested: true,
      updatedAt: report.index.updated,
      durationMs: report.durationMs,
      written: report.written,
      skipped: report.skipped,
      sources: report.sources,
      groups: report.index.groups,
      satcat: report.index.satcat,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// Route any /api/* request. Returns null for non-api paths so the caller can
// fall through to static assets.
export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) {
    return null;
  }

  const groupMatch = /^\/api\/gp\/([^/]+)\.json$/.exec(path);
  if (groupMatch) {
    // Malformed percent-encoding (e.g. /api/gp/%zz.json) throws URIError; treat
    // it as an unknown group rather than a 500 (handleGroup's name check rejects
    // anything exotic that does decode anyway).
    let name: string;
    try {
      name = decodeURIComponent(groupMatch[1]!);
    } catch {
      return notFound();
    }
    return handleGroup(name, request, env);
  }
  if (path === "/api/groups.json") {
    return handleIndex(env);
  }
  if (path === "/api/refresh") {
    return handleRefresh(request, env);
  }
  if (path === "/api/ingest") {
    return handleIngest(request, env);
  }
  if (path === "/api/graphql") {
    return handleGraphql(request, env);
  }
  return notFound();
}
