import { GROUP_NAME_RE } from "./configValidation.ts";
import { withConfig } from "./groupsIndex.ts";
import { bundleFetch, parseIngestBundle, readReport } from "./pushProtocol.ts";
import type { RefreshReport } from "./refresh.ts";
import { type GroupStore, kvGroupStore, upstreamStatuses } from "./store.ts";
import { recordFailure, recordUnchanged, storeUpstream } from "./upstream.ts";
import { UPSTREAMS, upstreamSpec } from "./upstreams.ts";
import { groupsConfig, refreshAll, refreshAllUpstreams } from "./workerRuntime.ts";

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

async function handleGroup({ request, store, param: encodedName }: RouteContext): Promise<Response> {
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
async function handleIndex({ request, store }: RouteContext): Promise<Response> {
  const body = JSON.stringify(withConfig(await store.readIndex(), groupsConfig));
  return conditional(request, body, `W/"groups-${fnv1a(body)}"`);
}

/**
 * The scheduled refresh plus a per-source report. One run pulls ~7 MB from CelesTrak,
 * which firewalls by IP (250 MB/day) across Cloudflare's shared egress, hence the
 * token and the cooldown. Within the cooldown it answers 429 with the stored index.
 */
async function handleRefresh({ store }: RouteContext): Promise<Response> {
  const previous = await store.readIndex();
  const sinceMs = Date.now() - Date.parse(previous.updated);
  if (Number.isFinite(sinceMs) && sinceMs < REFRESH_COOLDOWN_MS) {
    const retryAfterMs = REFRESH_COOLDOWN_MS - sinceMs;
    return jsonResponse(
      { refreshed: false, reason: "cooldown", updatedAt: previous.updated, retryAfterMs, groups: previous.groups },
      { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)), ...NO_STORE } },
    );
  }
  return jsonResponse({ refreshed: true, ...reportBody(await refreshAll(store)) }, { headers: NO_STORE });
}

/**
 * The scheduled refresh over payloads downloaded off-Worker (scripts/push-gp.mjs), for
 * when CelesTrak firewalls Cloudflare's egress. No cooldown: it spends no CelesTrak budget.
 */
async function handleIngest({ request, store }: RouteContext): Promise<Response> {
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
  return jsonResponse({ ingested: true, ...reportBody(await refreshAll(store, bundleFetch(sources))) }, { headers: NO_STORE });
}

/**
 * push-catalog's one call per table (ADR 0008): a body is a new file, which is stored
 * only if it parses; an empty body reports that upstream answered 304
 * (`X-Upstream-Status`) or failed (`X-Upstream-Error`).
 */
async function handleUpstreamPut({ request, store, param: name }: RouteContext): Promise<Response> {
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

/** The Worker downloads every upstream table itself, each conditional on its stored file. */
async function handleUpstreamRefresh({ store }: RouteContext): Promise<Response> {
  return jsonResponse({ sources: await refreshAllUpstreams(store) }, { headers: NO_STORE });
}

/**
 * How fresh everything is: each upstream table's status and each group's last write,
 * with `stale` set past a threshold, so an uptime monitor can watch one keyword. Public:
 * nothing in it is secret, and push-catalog reads its ETags here.
 */
async function handleStatus({ store }: RouteContext): Promise<Response> {
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

/** What a route's handler gets. */
interface RouteContext {
  request: Request;
  store: GroupStore;
  /** The pattern's capture, if it has one. */
  param: string;
}

interface Route {
  pattern: RegExp;
  /**
   * A write: any other method is answered 405, then the refresh token is checked.
   * Unset: a public read, which answers every method, as it always has.
   */
  write?: "POST" | "PUT";
  handle(context: RouteContext): Promise<Response>;
}

/** The first match wins. */
const ROUTES: Route[] = [
  { pattern: /^\/api\/gp\/([^/]+)\.json$/, handle: handleGroup },
  { pattern: /^\/api\/groups\.json$/, handle: handleIndex },
  { pattern: /^\/api\/refresh$/, write: "POST", handle: handleRefresh },
  { pattern: /^\/api\/ingest$/, write: "POST", handle: handleIngest },
  { pattern: /^\/api\/status$/, handle: handleStatus },
  /** Before the table route: no table is called "refresh". */
  { pattern: /^\/api\/upstream\/refresh$/, write: "POST", handle: handleUpstreamRefresh },
  { pattern: /^\/api\/upstream\/([a-zA-Z]+)$/, write: "PUT", handle: handleUpstreamPut },
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
    if (route.write !== undefined && request.method !== route.write) {
      return jsonResponse({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: route.write } });
    }
    const rejection = route.write === undefined ? null : rejectUnauthorized(request, env);
    return rejection ?? route.handle({ request, store: kvGroupStore(env.GP_KV), param: match[1] ?? "" });
  }
  return notFound();
}
