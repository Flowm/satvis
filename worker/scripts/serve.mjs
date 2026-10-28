#!/usr/bin/env node
// The Docker image's entrypoint: the Worker on wrangler's local runtime, plus the
// two things that runtime lacks for serving. It answers its own internals under
// /cdn-cgi/ for anyone, so it listens on loopback behind a proxy that refuses them,
// and this file runs the refreshes through the API on its own schedule. The deployed
// Worker has none, because CelesTrak firewalls Cloudflare's egress, which a
// self-hosted container does not share.

import http from "node:http";

import { unstable_startWorker } from "wrangler";

const port = Number(process.env.PORT ?? 8080);
const upstream = `http://127.0.0.1:${port + 1}`;
/** Without REFRESH_TOKEN, one only this process knows: the refresh endpoints refuse everyone else. */
const token = process.env.REFRESH_TOKEN || crypto.randomUUID();

const worker = await unstable_startWorker({
  config: new URL("../wrangler.jsonc", import.meta.url).pathname,
  bindings: { REFRESH_TOKEN: { type: "secret_text", value: token } },
  dev: { server: { hostname: "127.0.0.1", port: port + 1 }, persist: process.env.PERSIST_DIR ?? "/data", watch: false, inspector: false },
});
await worker.ready;

http
  .createServer((req, res) => {
    if (req.url?.startsWith("/cdn-cgi/")) {
      res.writeHead(404).end();
      return;
    }
    const proxied = http.request(upstream + req.url, { method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    proxied.on("error", () => res.headersSent || res.writeHead(502).end());
    req.pipe(proxied);
  })
  .listen(port, () => console.log(`satvis listening on port ${port}`));

/** POST /api/refresh (the GP data) or /api/upstream/refresh (the tables). */
async function refresh(path) {
  const response = await fetch(`${upstream}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch((error) => error);
  await response.body?.cancel();
  console.log(`POST ${path}: ${response.status ?? response.message}`);
}

/** When the groups were built, and how many of the tables /api/status lists are stored. */
async function storedTables() {
  const { built, sources } = await (await fetch(`${upstream}/api/status`)).json();
  const tables = Object.values(sources);
  return { built, stored: tables.filter((source) => source.stored).length, total: tables.length };
}

// A fresh volume would otherwise have no satellites until the first scheduled refresh,
// and a volume from before the tables existed no enrichment until the next of each.
// Tables first, so the GP refresh enriches from them. GP runs again only for a table
// that arrived: a table that cannot be fetched would otherwise cost CelesTrak a full
// download on every restart.
const before = await storedTables();
let after = before;
if (before.stored < before.total) {
  await refresh("/api/upstream/refresh");
  after = await storedTables();
}
if (!before.built || after.stored > before.stored) {
  await refresh("/api/refresh");
}

/**
 * Every 6 h at :23 UTC, off the hour as CelesTrak asks. 6 h rather than 3 halves our
 * share of its 250 MB/day per-IP budget: ~7 MB a run is ~29 MB/day.
 */
const gpDue = (date) => date.getUTCHours() % 6 === 0 && date.getUTCMinutes() === 23;
/** Daily at 04:47 UTC: SATCAT changes once or twice a day, GCAT about weekly. */
const tablesDue = (date) => date.getUTCHours() === 4 && date.getUTCMinutes() === 47;

function scheduleTick() {
  setTimeout(
    () => {
      const now = new Date();
      if (tablesDue(now)) {
        refresh("/api/upstream/refresh");
      }
      if (gpDue(now)) {
        refresh("/api/refresh");
      }
      scheduleTick();
    },
    60_000 - (Date.now() % 60_000),
  );
}
scheduleTick();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => worker.dispose().then(() => process.exit(0)));
}
