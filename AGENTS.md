# AGENTS.md

Satellite orbit visualization: a Vue 3 + Vite + CesiumJS + Nuxt UI single-page app
in `src/`, with a Cloudflare Worker backend in `worker/` (the `satvis-worker`
workspace package). One `pnpm install` at the root covers both.

## Where things are written down

- **`CONTEXT.md`** — the domain glossary. Use those names in code and discussion,
  and sharpen an entry when the term drifts.
- **`README.md`** — setup, dev and full-stack workflows, the CelesTrak → KV data
  pipeline, plugin config, the offline base map, worker-less deploys.
- **`docs/adr/`** — decisions and the alternatives they beat: url parameters
  (0001), satellite metadata and swath extents (0002), the sky view (0003),
  compass aiming (0004), surface models (0005).
- **`docs/manual-verification.md`** — the checks jsdom cannot run. Rerun the ones
  covering code you change, and record what they returned.
- **`worker/src/gp/types.ts`** — the group, preset and satellite-table config
  schema, field by field.
- **`src/modules/benchmark/README.md`** — the benchmark framework, and how the
  frame cost scales.
- **`ios/AGENTS.md`** — the iOS app: building, testing, screenshots, and its
  contract with the web page.

## Architecture

- The worker refreshes each group from CelesTrak into Workers KV on a 6 h cron and
  serves `/api/gp/<group>.json` and `/api/groups.json`. `POST /api/refresh` and
  `POST /api/ingest` run the same pass on demand behind a bearer token.
- `pnpm update-gp` runs that same pipeline locally into a static `data/gp/`
  snapshot; the app probes `/api/groups.json` and falls back to it.
- Config is declarative YAML — core in `worker/src/config/satvis.core.yaml`,
  plugins in `data/custom/<plugin>/satvis.yaml` — merged by
  `pnpm --filter satvis-worker generate-groups` into a gitignored JSON.
- Per-satellite metadata is attached to records **at refresh time**. There is no
  metadata endpoint and no browser-side rule matching: a record either carries
  the bag or the frontend applies its defaults (`src/config/satelliteMetadata.ts`).
- `data/` also holds the generated Cesium assets and the 3D-model plugins, copied
  into `dist/` at build time. Entrypoints are the MPA inputs in `vite.config.ts`.

## Commands

`package.json` holds the scripts. What it does not say:

- Worker scripts run through `pnpm --filter satvis-worker <script>`.
- `pnpm lint` covers both packages, but `pnpm test` covers only the frontend —
  the worker suite is `pnpm --filter satvis-worker test`. CI runs lint, both test
  suites, then build.
- Full-stack dev is `pnpm dev:worker` plus
  `SATVIS_API_PROXY=http://localhost:8080 pnpm dev`. Plain `pnpm dev` proxies
  `/api` to <https://satvis.space>.
- A fresh `git worktree` has no submodules. Run `git submodule update --init`, or
  `data/models` stays empty and the 3D models have no fallback for that yet.

## Conventions

- TypeScript strict, `noUnusedLocals`, `noUncheckedIndexedAccess`; prefix a
  deliberately unused variable with `_`.
- Component names in templates are kebab-case.
- `pnpm lint:fix` formats (`oxfmt`, `printWidth: 180`, sorted imports).
- Keep `data/custom/` out of commits — private plugin data.

## Gotchas

- **Probes read the answer, not the status.** `pnpm dev` answers a file that never
  existed with `index.html` and a 200, and a ranged request for one with a 206 and
  `content-type: text/html`, so `response.ok` alone reports success on exactly the
  checkouts a probe exists to detect. Where the answer is knowable at build time,
  prefer a `define` (`__IMAGERY_MAX_LEVEL__` in `vite.config.ts`). Where it is not,
  check the content type, and use a ranged `GET` rather than a `HEAD` — the Cache
  API ignores non-GET requests, so a `HEAD` misses the service worker's caches
  (`src/config/starMaps.ts`).
- **`public/404.html` is load-bearing.** It keeps not-found handling in the asset
  router, so a missing file never reaches the Worker and is never a billed
  invocation. `/ot` resolves through a `_redirects` 200 rewrite rather than a
  second html file that could drift.
- **`navigateFallbackDenylist` is about navigations only.** Workbox rejects a
  request whose mode is not `navigate` before it reads the list, so this cannot
  change what a `fetch()` receives. What it controls is opening a data url
  directly; `/api/`, `/data/` and `/cesium/` are denylisted by prefix, because an
  extension list alone missed `.json`.
- **No service-worker cache for ion or Google tiles.** Cesium permits caching only
  as a general mechanism that carries other traffic too, and Google's Map Tiles
  policies restrict caching `tile.googleapis.com`. Neither host appears in
  `dist/sw.js`.
- **The committed Cesium ion token is restricted to satvis.space.** ion rejects it
  on localhost, on `deploy:preview` origins and in foreign iframes, so local work
  on terrain or the surface models needs an unrestricted `VITE_CESIUM_ION_TOKEN`.
  Without one they fail loudly (`src/config/ion.ts`).
- **Dev and preview are cross-origin isolated; production is not.** The COOP/COEP
  headers in `vite.config.ts` are what expose
  `performance.measureUserAgentSpecificMemory()` to the benchmark panel. One
  symptom to recognise: an isolated document refuses to start a worker from a
  service-worker-cached response carrying no COEP header, and the result is a
  **black globe with the satellites still drawing** — clear that origin's service
  worker.
- **`HTTP 522` on every CelesTrak source is CelesTrak firewalling Cloudflare's
  shared egress**, not a Cloudflare fault — celestrak.org is not behind Cloudflare
  and cannot emit a 522 itself. The cron cannot recover on its own; push the data
  in with `pnpm --filter satvis-worker push-gp` (README, "Downloading off-Worker").
- **Run `pnpm update-imagery` before `pnpm deploy`.** `data/imagery/` levels 0–2
  are committed and 3–5 are generated, and the build only warns about their
  absence — so a forgotten run ships a globe capped at level 2.
- **Everything under `data/` ships.** The static-copy glob takes it wholesale,
  which is why the generators live under `scripts/`.

## Deployment

`pnpm deploy` builds the frontend and deploys the worker, which needs a KV
namespace bound as `GP_KV` (`worker/wrangler.jsonc`). After a first deploy KV is
empty until a cron run fills it — either wait (≤ 6 h) or force a fill against the
deployed KV:

```sh
cd worker
wrangler dev --remote --test-scheduled
curl "http://localhost:8080/__scheduled?cron=23+*%2F6+*+*+*"
```
