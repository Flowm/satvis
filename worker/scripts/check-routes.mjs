// What the asset router answers under the real wrangler.jsonc, public/404.html and
// public/_redirects. A request that reaches the Worker is a billed invocation; asset
// traffic must not be one.
//
// `wrangler dev`, not vitest-pool-workers: its SELF.fetch goes straight to the Worker,
// past the asset router. The site stands in for dist/: the routing config is under
// test, not the bundle.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const workerDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(workerDir, "..", "public");

/** The Worker's own answer to a path the router passed it (src/index.ts). */
const WORKER_NOT_FOUND = "Not Found";

const scratch = mkdtempSync(path.join(tmpdir(), "satvis-routes-"));
const site = path.join(scratch, "site");

/** dist/ in miniature: the html entries, a Cesium asset, one imagery tile, and the real routing files. */
function buildSite() {
  for (const dir of ["cesium/Assets/Textures/NaturalEarthII", "data/imagery/NaturalEarthII/0/0"]) {
    mkdirSync(path.join(site, dir), { recursive: true });
  }
  for (const file of ["404.html", "_redirects"]) {
    cpSync(path.join(publicDir, file), path.join(site, file));
  }
  for (const page of ["index.html", "embedded.html", "test.html"]) {
    writeFileSync(path.join(site, page), `<!doctype html><title>${page}</title>`);
  }
  writeFileSync(path.join(site, "cesium/Assets/Textures/NaturalEarthII/tilemapresource.xml"), "<TileMap/>");
  writeFileSync(path.join(site, "data/imagery/NaturalEarthII/0/0/0.webp"), "webp");
}

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

let wrangler;
let origin;

before(async () => {
  buildSite();
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  wrangler = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--assets",
      site,
      "--persist-to",
      path.join(scratch, "state"),
      "--inspector-port",
      "0",
      "--show-interactive-dev-session=false",
    ],
    { cwd: workerDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  let output = "";
  wrangler.stdout.on("data", (chunk) => (output += chunk));
  wrangler.stderr.on("data", (chunk) => (output += chunk));
  // Ready once it answers; wrangler's own log line has changed between releases.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fetch(`${origin}/api/groups.json`);
      return;
    } catch {
      if (Date.now() > deadline || wrangler.exitCode !== null) {
        throw new Error(`wrangler dev did not start:\n${output}`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
});

after(() => {
  wrangler?.kill();
  rmSync(scratch, { recursive: true, force: true });
});

/** Status, type, redirect target, and whether the Worker answered rather than the asset router. */
async function request(pathname) {
  const response = await fetch(`${origin}${pathname}`, { redirect: "manual" });
  const body = await response.text();
  const type = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    type: type.split(";")[0],
    location: response.headers.get("location"),
    body,
    worker: pathname.startsWith("/api/") || (type.startsWith("text/plain") && body === WORKER_NOT_FOUND),
  };
}

test("the app's pages are assets", async () => {
  const paths = ["/", "/ot"];
  const pages = await Promise.all(paths.map(request));
  pages.forEach((page, index) => {
    assert.deepEqual([page.status, page.type, page.worker], [200, "text/html", false], paths[index]);
    // /ot is a 200 rewrite to /, so the url keeps the path the preset is read from.
    assert.match(page.body, /index\.html/, paths[index]);
  });
});

test("html file names redirect to their clean paths, and old links to theirs", async () => {
  const cases = [
    ["/embedded.html", "/embedded", 307],
    ["/test.html", "/test", 307],
    ["/ot.html", "/ot", 301],
    ["/next/about", "/about", 301],
  ];
  const redirects = await Promise.all(cases.map(([from]) => request(from)));
  redirects.forEach((redirect, index) => {
    const [from, to, status] = cases[index];
    assert.deepEqual([redirect.status, new URL(redirect.location, origin).pathname, redirect.worker], [status, to, false], from);
  });
});

test("a missing file gets the 404 page from the router, never index.html or the Worker", async () => {
  const paths = ["/typo-route", "/data/imagery/NaturalEarthII/0/0/1.webp", "/data/gp/weather.json", "/cesium/Assets/missing.js"];
  const answers = await Promise.all(paths.map(request));
  answers.forEach((missing, index) => {
    assert.deepEqual([missing.status, missing.type, missing.worker], [404, "text/html", false], paths[index]);
    assert.match(missing.body, /Not found — Satvis/, paths[index]);
  });
});

test("existing data and Cesium files are served as themselves", async () => {
  const tile = await request("/data/imagery/NaturalEarthII/0/0/0.webp");
  assert.deepEqual([tile.status, tile.type, tile.worker], [200, "image/webp", false]);
  const xml = await request("/cesium/Assets/Textures/NaturalEarthII/tilemapresource.xml");
  assert.deepEqual([xml.status, xml.type, xml.worker], [200, "application/xml", false]);
});

test("only /api reaches the Worker", async () => {
  const api = await request("/api/groups.json");
  assert.deepEqual([api.status, api.type], [200, "application/json"]);
  // The detection itself: an api path the Worker does not know comes back as its own text.
  const unknown = await request("/api/nothing-here");
  assert.equal(unknown.status, 404);
});
