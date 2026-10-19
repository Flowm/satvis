import { GROUP_NAME_RE } from "./configValidation.ts";
import { withConfig } from "./groupsIndex.ts";
import { parseIngestBundle, readReport } from "./pushProtocol.ts";
import type { RefreshReport } from "./refresh.ts";
import { type GroupStore, kvGroupStore, upstreamStatuses } from "./store.ts";
import { recordFailure, recordUnchanged, storeUpstream } from "./upstream.ts";
import { UPSTREAMS, upstreamSpec } from "./upstreams.ts";
import { groupsConfig, ingestAll, refreshAll, refreshAllUpstreams } from "./workerRuntime.ts";

/**
 * POST /api/refresh does not re-hit CelesTrak within this window of the last refresh, cron included.
 */
const REFRESH_COOLDOWN_MS = 60_000;
/** /api/status marks a group stale after this long without a write; push-gp runs several times a day. */
const GROUP_STALE_AFTER_MS = 12 * 3600_000;

const NO_STORE = { "Cache-Control": "no-store" };

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
  return jsonResponse({ error: reason }, { status: 400, headers: NO_STORE });
}

/** Null when the caller is authorized. */
function rejectUnauthorized(request: Request, env: Env): Response | null {
  // `wrangler types` cannot see secrets. An unset secret disables the endpoint rather than leaving it open.
  const expected = (env as Env & { REFRESH_TOKEN?: string }).REFRESH_TOKEN;
  if (!expected) {
    return jsonResponse({ error: "Refresh is not configured" }, { status: 503, headers: NO_STORE });
  }
  if (request.headers.get("Authorization") !== `Bearer ${expected}`) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  return null;
}

/** A public, cacheable JSON body, or a 304 when the client holds `etag`. */
function conditional(request: Request, body: string, etag: string, headers?: Record<string, string>): Response {
  const all = { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ETag: etag, ...headers };
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: all });
  }
  return new Response(body, { headers: all });
}

/** What POST /api/refresh and /api/ingest answer after a run. */
function reportBody(report: RefreshReport): Record<string, unknown> {
  return {
    updatedAt: report.index.updated,
    durationMs: report.durationMs,
    written: report.written,
    skipped: report.skipped,
    sources: report.sources,
    groups: report.index.groups,
  };
}

async function handleGroup(request: Request, store: GroupStore, encodedName: string): Promise<Response> {
  // Malformed percent-encoding (/api/gp/%zz.json) throws a URIError; answer 404, not 500.
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    return notFound();
  }
  if (!GROUP_NAME_RE.test(name)) {
    return notFound();
  }
  const group = await store.readGroup(name);
  if (group === undefined) {
    return notFound();
  }
  const updated = group.metadata?.updated;
  const updatedMs = updated ? Date.parse(updated) : Date.now();
  return conditional(request, group.body, `W/"${name}-${updatedMs}"`, { "Last-Modified": new Date(updatedMs).toUTCString() });
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
async function handleIndex(request: Request, store: GroupStore): Promise<Response> {
  const body = JSON.stringify(withConfig(await store.readIndex(), groupsConfig));
  return conditional(request, body, `W/"groups-${fnv1a(body)}"`);
}

/**
 * The scheduled refresh plus a per-source report. One run pulls ~7 MB from CelesTrak,
 * which firewalls by IP (250 MB/day) across Cloudflare's shared egress, hence the
 * token and the cooldown. Within the cooldown it answers 429 with the stored index.
 */
async function handleRefresh(env: Env, store: GroupStore): Promise<Response> {
  const previous = await store.readIndex();
  const sinceMs = Date.now() - Date.parse(previous.updated);
  if (Number.isFinite(sinceMs) && sinceMs < REFRESH_COOLDOWN_MS) {
    const retryAfterMs = REFRESH_COOLDOWN_MS - sinceMs;
    return jsonResponse(
      { refreshed: false, reason: "cooldown", updatedAt: previous.updated, retryAfterMs, groups: previous.groups },
      { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)), ...NO_STORE } },
    );
  }
  return jsonResponse({ refreshed: true, ...reportBody(await refreshAll(env)) }, { headers: NO_STORE });
}

/**
 * The scheduled refresh over payloads downloaded off-Worker (scripts/push-gp.mjs), for
 * when CelesTrak firewalls Cloudflare's egress. No cooldown: it spends no CelesTrak budget.
 */
async function handleIngest(request: Request, env: Env): Promise<Response> {
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
  return jsonResponse({ ingested: true, ...reportBody(await ingestAll(env, sources)) }, { headers: NO_STORE });
}

/**
 * push-catalog's one call per table (ADR 0008): a body is a new file, which is stored
 * only if it parses; an empty body reports that upstream answered 304
 * (`X-Upstream-Status`) or failed (`X-Upstream-Error`).
 */
async function handleUpstreamPut(request: Request, store: GroupStore, name: string): Promise<Response> {
  const spec = upstreamSpec(name);
  if (spec === undefined) {
    return notFound();
  }
  const now = new Date().toISOString();
  const report = readReport(request.headers);
  if ("error" in report) {
    return jsonResponse({ name, ...(await recordFailure(spec.name, store, report.error, now)) }, { headers: NO_STORE });
  }
  if ("notModified" in report) {
    return jsonResponse({ name, ...(await recordUnchanged(spec, store, now)) }, { headers: NO_STORE });
  }
  const body = await request.text();
  if (body === "") {
    return badRequest("a new file needs a body; report an unchanged one with X-Upstream-Status: 304");
  }
  const { stored, status } = await storeUpstream(spec, store, body, report.etag, now);
  return jsonResponse({ name, ...status }, { status: stored ? 200 : 422, headers: NO_STORE });
}

/**
 * How fresh everything is: each upstream table's status and each group's last write,
 * with `stale` set past a threshold, so an uptime monitor can watch one keyword. Public:
 * nothing in it is secret, and push-catalog reads its ETags here.
 */
async function handleStatus(store: GroupStore): Promise<Response> {
  const [index, statuses] = await Promise.all([store.readIndex(), upstreamStatuses(store)]);
  const now = Date.now();
  const olderThan = (time: string | null | undefined, ms: number): boolean => time === null || time === undefined || now - Date.parse(time) > ms;
  const sources = Object.fromEntries(
    UPSTREAMS.map(({ name, staleAfterMs }) => {
      const status = statuses[name] ?? { stored: false };
      return [name, { ...status, stale: !status.stored || olderThan(status.checked, staleAfterMs) }];
    }),
  );
  const groups = withConfig(index, groupsConfig).groups.map(({ name, updated, count, lastError, lastErrorAt }) => ({
    name,
    updated,
    count,
    lastError,
    lastErrorAt,
    stale: olderThan(updated, GROUP_STALE_AFTER_MS),
  }));
  const stale = [...Object.values(sources), ...groups].some((entry) => entry.stale);
  return jsonResponse({ stale, built: index.updated || null, sources, groups }, { headers: NO_STORE });
}

interface Route {
  pattern: RegExp;
  /** Any other method is answered 405. Unset: every method reads, as the public routes always have. */
  method?: "POST" | "PUT";
  /** Needs the refresh token; checked after the method. */
  auth?: true;
  /** `param` is the pattern's capture, if it has one. */
  handle(request: Request, env: Env, store: GroupStore, param: string): Promise<Response>;
}

/** The first match wins. */
const ROUTES: Route[] = [
  { pattern: /^\/api\/gp\/([^/]+)\.json$/, handle: (request, _env, store, name) => handleGroup(request, store, name) },
  { pattern: /^\/api\/groups\.json$/, handle: (request, _env, store) => handleIndex(request, store) },
  { pattern: /^\/api\/refresh$/, method: "POST", auth: true, handle: (_request, env, store) => handleRefresh(env, store) },
  { pattern: /^\/api\/ingest$/, method: "POST", auth: true, handle: (request, env) => handleIngest(request, env) },
  { pattern: /^\/api\/status$/, handle: (_request, _env, store) => handleStatus(store) },
  // Before the table route: no table is called "refresh". The Worker downloads every table itself.
  {
    pattern: /^\/api\/upstream\/refresh$/,
    method: "POST",
    auth: true,
    handle: async (_request, env) => jsonResponse({ sources: await refreshAllUpstreams(env) }, { headers: NO_STORE }),
  },
  { pattern: /^\/api\/upstream\/([a-zA-Z]+)$/, method: "PUT", auth: true, handle: (request, _env, store, name) => handleUpstreamPut(request, store, name) },
];

/** Null for non-api paths, which fall through to static assets. */
export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/")) {
    return null;
  }
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (match === null) {
      continue;
    }
    if (route.method !== undefined && request.method !== route.method) {
      return jsonResponse({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: route.method } });
    }
    const rejection = route.auth ? rejectUnauthorized(request, env) : null;
    return rejection ?? route.handle(request, env, kvGroupStore(env.GP_KV), match[1] ?? "");
  }
  return notFound();
}
