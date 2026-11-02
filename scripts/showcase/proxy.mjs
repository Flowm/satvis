// Serves a site as it is, but with the orbits in pinned.json in place of the live ones, so
// that a featured bookmark's `pictureAt` draws a low orbit where it was when the moment was
// picked, however long ago that was. capture.mjs puts it in front of the dev server's /api;
// ios/scripts/screenshots.sh runs it alone, as the site the app opens:
// `node scripts/showcase/proxy.mjs [site]` serves at PROXY_URL until stopped.
//
// A pinned record keeps its live metadata and model, which the apps of the day read. Only
// GET: neither the pictures nor the app on another site than satvis.space send anything.

import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

/** Where the proxy listens, which ios/scripts/screenshots.sh names again. */
export const PROXY_URL = "http://127.0.0.1:5198";

/** Each pinned satellite's orbit, by NORAD id. */
const pinned = new Map(JSON.parse(fs.readFileSync(new URL("pinned.json", import.meta.url), "utf8")).map((elements) => [elements.NORAD_CAT_ID, elements]));

/** Serves `site` at PROXY_URL, and resolves once it listens to a function that stops it. */
export async function startProxy(site) {
  const server = http.createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    try {
      const url = new URL(request.url, site);
      const upstream = await fetch(url);
      let body = Buffer.from(await upstream.arrayBuffer());
      if (upstream.ok && /^\/api\/gp\/[^/]+\.json$/.test(url.pathname)) {
        const records = JSON.parse(body.toString("utf8"));
        body = Buffer.from(JSON.stringify(records.map((record) => Object.assign(record, pinned.get(record.NORAD_CAT_ID)))));
      }
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" }).end(body);
    } catch (error) {
      response.writeHead(502).end(String(error));
    }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(Number(new URL(PROXY_URL).port), "127.0.0.1", resolve));
  return () => server.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startProxy(process.argv[2] ?? "https://satvis.space");
}
