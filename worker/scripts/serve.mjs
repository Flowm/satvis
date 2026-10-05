#!/usr/bin/env node
// The Docker image's entrypoint: the Worker on wrangler's local runtime, plus the
// two things that runtime lacks for serving. It never fires crons, and it answers
// /cdn-cgi/handler/scheduled for anyone, so it listens on loopback behind a proxy
// that refuses /cdn-cgi/ and this file triggers the crons itself.

import http from "node:http";

import { unstable_startWorker } from "wrangler";

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

const crons = (worker.config.triggers ?? []).filter((t) => t.type === "cron").map((t) => t.cron);

async function runScheduled(cron) {
  const response = await fetch(`${upstream}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(cron)}`).catch((error) => error);
  console.log(`cron ${cron}: ${response.status ?? response.message}`);
}

// A fresh volume would otherwise have no satellites until the first cron.
const index = await (await fetch(`${upstream}/api/groups.json`)).json();
if (!index.updated && crons[0]) {
  await runScheduled(crons[0]);
}

// Cron fields as Cloudflare evaluates them, in UTC: `*`, `a`, `a-b`, `/n` steps, comma lists.
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
