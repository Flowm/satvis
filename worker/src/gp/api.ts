import { coerceIndex, withConfig } from "./evaluate.ts";
import { groupsConfig, ingestAll, type IngestSource, refreshAll } from "./refresh.ts";
import { GP_INDEX_KEY, GP_KEY_PREFIX, type GroupWriteMetadata } from "./store.ts";

const GROUP_NAME_RE = /^[a-zA-Z0-9_-]+$/;
/**
 * POST /api/refresh does not re-hit CelesTrak within this window of the last refresh, cron included.
 */
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

/** Null when the caller is authorized. */
function rejectUnauthorized(request: Request, env: Env): Response | null {
  // `wrangler types` cannot see secrets. An unset secret disables the endpoint rather than leaving it open.
  const expected = (env as Env & { REFRESH_TOKEN?: string }).REFRESH_TOKEN;
  if (!expected) {
    return jsonResponse({ error: "Refresh is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (request.headers.get("Authorization") !== `Bearer ${expected}`) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  return null;
}

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

/**
 * FNV-1a, 32 bit. Only an ETag: two bodies colliding would cost one client one
 * stale index for one max-age.
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The ETag hashes the body: a refresh or a deploy changes it, and no single timestamp covers both.
 */
async function handleIndex(request: Request, env: Env): Promise<Response> {
  const index = withConfig(coerceIndex(await env.GP_KV.get(GP_INDEX_KEY, "json")), groupsConfig);
  const body = JSON.stringify(index);
  const etag = `W/"groups-${fnv1a(body)}"`;
  const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ETag: etag };
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { headers });
}

/**
 * The cron's refresh plus a per-source report. One run pulls ~7 MB from CelesTrak,
 * which firewalls by IP (250 MB/day) across Cloudflare's shared egress, hence the
 * token and the cooldown. Within the cooldown it answers 429 with the stored index.
 */
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

/**
 * Returns the first problem as a string. Strict, because a malformed bundle would
 * otherwise read as an upstream outage.
 */
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
    // A 304 carries neither: the stored value already is the payload.
    if (body === undefined && error === undefined && status !== 304) {
      return `body.sources[${i}] needs either body or error`;
    }
    parsed.push({ key, url, status, body, error, validator });
  }
  return parsed;
}

/**
 * The cron's refresh over payloads downloaded off-Worker (scripts/push-gp.mjs), for
 * when CelesTrak firewalls Cloudflare's egress. No cooldown: it spends no CelesTrak budget.
 */
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

/** Null for non-api paths, which fall through to static assets. */
export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/")) {
    return null;
  }

  const groupMatch = /^\/api\/gp\/([^/]+)\.json$/.exec(path);
  if (groupMatch) {
    // Malformed percent-encoding (/api/gp/%zz.json) throws a URIError; answer 404, not 500.
    let name: string;
    try {
      name = decodeURIComponent(groupMatch[1]!);
    } catch {
      return notFound();
    }
    return handleGroup(name, request, env);
  }
  if (path === "/api/groups.json") {
    return handleIndex(request, env);
  }
  if (path === "/api/refresh") {
    return handleRefresh(request, env);
  }
  if (path === "/api/ingest") {
    return handleIngest(request, env);
  }
  return notFound();
}
