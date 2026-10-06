#!/usr/bin/env node
// The Docker image's entrypoint: the Worker on wrangler's local runtime, plus the
// two things that runtime lacks for serving. It never fires crons, and it answers
// /cdn-cgi/handler/scheduled for anyone, so it listens on loopback behind a proxy
// that refuses /cdn-cgi/ and this file triggers the refresh itself. The schedule is
// its own: the deployed Worker has none, because CelesTrak firewalls Cloudflare's
// egress, which a self-hosted container does not share.

import http from "node:http";

import { unstable_startWorker } from "wrangler";

import { CATALOG_CRON, GP_CRON } from "../src/gp/schedule.ts";

const port = Number(process.env.PORT ?? 8080);
const upstream = `http://127.0.0.1:${port + 1}`;

const worker = await unstable_startWorker({
  config: new URL("../wrangler.jsonc", import.meta.url).pathname,
  bindings: process.env.REFRESH_TOKEN ? { REFRESH_TOKEN: { type: "secret_text", value: process.env.REFRESH_TOKEN } } : {},
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

/** Both refreshes; the scheduled handler tells them apart by cron. */
const crons = [GP_CRON, CATALOG_CRON];

async function runScheduled(cron) {
  const response = await fetch(`${upstream}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(cron)}`).catch((error) => error);
  console.log(`cron ${cron}: ${response.status ?? response.message}`);
}

/**
 * A fresh volume would otherwise have no satellites until the first scheduled refresh,
 * and a volume from before the tables existed no enrichment until the next of each.
 * Tables first, so the GP refresh enriches from them.
 */
const status = await (await fetch(`${upstream}/api/status`)).json();
const tablesMissing = Object.values(status.sources).some((source) => !source.stored);
if (tablesMissing) {
  await runScheduled(CATALOG_CRON);
}
if (tablesMissing || !status.built) {
  await runScheduled(GP_CRON);
}

/** Cron fields as Cloudflare evaluates them, in UTC: `*`, `a`, `a-b`, `/n` steps, comma lists. */
const fieldValues = [(d) => d.getUTCMinutes(), (d) => d.getUTCHours(), (d) => d.getUTCDate(), (d) => d.getUTCMonth() + 1, (d) => d.getUTCDay()];
const fieldMinimums = [0, 0, 1, 1, 0];

function cronMatches(cron, date) {
  return cron
    .trim()
    .split(/\s+/)
    .every((field, i) =>
      field.split(",").some((part) => {
        const value = fieldValues[i](date);
        const [range, step] = part.split("/");
        const [lo, hi] = range === "*" ? [fieldMinimums[i], Infinity] : range.split("-").map(Number);
        return value >= lo && value <= (hi ?? (step ? Infinity : lo)) && (value - lo) % Number(step ?? 1) === 0;
      }),
    );
}

function scheduleTick() {
  setTimeout(
    () => {
      const now = new Date();
      crons.filter((cron) => cronMatches(cron, now)).forEach(runScheduled);
      scheduleTick();
    },
    60_000 - (Date.now() % 60_000),
  );
}
scheduleTick();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => worker.dispose().then(() => process.exit(0)));
}
