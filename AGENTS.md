# AGENTS.md

Satellite orbit visualization: a Vue 3 + Vite + CesiumJS + Nuxt UI single-page app
in `src/`, with a Cloudflare Worker backend in `worker/` (the `satvis-worker`
workspace package). One `pnpm install` at the root covers both.

## Where things are written down

- **`CONTEXT.md`** — the domain glossary. Use its names in code and discussion,
  and sharpen an entry when a term drifts.
- **`README.md`** — setup, dev and full-stack workflows, the CelesTrak → KV data
  pipeline, plugin config, the offline base map, deploying, worker-less deploys,
  Docker.
- **`docs/adr/`** — decisions and the alternatives they beat: url parameters
  (0001), satellite metadata and swath extents (0002), the sky view (0003),
  compass aiming (0004), surface models (0005), SATCAT enrichment (0006), model
  manifests (0007), GCAT and the one owner per metadata field (0008), the native
  iOS app (0009), visibility in the sky view (0010), bookmarks (0011).
- **`e2e/`** — Playwright specs against the running app: `journeys/` walks the main
  flows through the menus, `regressions/` pins down one past bug each, for what
  needs layout, a GPU or frames. Read `e2e/support/app.ts` before writing one: it
  holds the fixture, the helpers and why they count clock ticks.
- **`worker/src/gp/types.ts`** — the group, preset and satellite-table config
  schema, field by field.
- **`src/modules/benchmark/README.md`** — the benchmark framework, and how the
  frame cost scales.
- **`ios/AGENTS.md`** — the native iOS app: building, testing, its worker
  client, and its parity with the web app. Its manual checks, which no test can
  run, are `ios/docs/manual-verification.md`.

## Architecture

- The worker serves `/api/gp/<group>.json`, `/api/groups.json` and `/api/status`
  from Workers KV. `push-gp` downloads the GP data elsewhere and posts it to
  `POST /api/ingest`; `POST /api/refresh` fetches it from the Worker itself. Both run
  one refresh pass behind a bearer token. The upstream tables (SATCAT, GCAT) travel
  apart: `push-catalog` uploads them to `PUT /api/upstream/<name>`, or
  `POST /api/upstream/refresh` fetches them, and every GP refresh reads them from KV
  (ADR 0008). The deployed Worker has no cron; the Docker image schedules both
  (`worker/src/gp/schedule.ts`).
- `pnpm update-gp` runs that pipeline locally into a static `data/gp/` snapshot;
  the app probes `/api/groups.json` and falls back to it.
- Config is declarative YAML — core in `worker/src/config/satvis.core.yaml`,
  plugins in `data/custom/<plugin>/satvis.yaml` — merged by
  `pnpm --filter satvis-worker generate-groups` into a gitignored JSON.
- Per-satellite metadata is attached to records **at refresh time**. There is no
  metadata endpoint and no rule matching in the browser: a record either carries
  the bag or the frontend applies its defaults (`src/config/satelliteMetadata.ts`).
- A satellite's 3D model is the `modelFile` its model manifest gives it
  (`data/models/models.yaml`, `data/custom/*/models.yaml`), by NORAD id or by GCAT
  bus, never its name.
- The html entrypoints are the MPA inputs in `vite.config.ts`.

## Commands

`package.json` holds the scripts. What it does not say:

- Worker scripts run through `pnpm --filter satvis-worker <script>`.
- `pnpm lint` covers both packages, but `pnpm test` covers only the frontend —
  the worker suite is `pnpm --filter satvis-worker test`, which also starts
  `wrangler dev` to check the asset routing (`worker/scripts/check-routes.mjs`).
  `pnpm test:build` checks `dist/sw.js` after a build. CI runs lint, both test
  suites, the build with `test:build`, and `pnpm test:e2e`, and on macOS the
  native app's package tests, its Swift lint and a build of the app and its UI
  tests.
- `pnpm update-parity-fixtures` reruns the web code the native app is held to
  (`scripts/parity/`), and writes the tables it reads from the web app as they are
  (SATCAT labels, external links). Rerun it after changing propagation or its
  sampling grid, element-set parsing, pass prediction, the info panel's details
  and passes, the URL codec, the sky view's visibility (`visibility.ts`), the
  analytics sanitising (`posthogPrivacy.ts`), the pixel ratios
  (`config/rendering.ts`), or those tables; CI fails while the committed output
  is stale.
- `pnpm test:e2e` renders with SwiftShader, as a GPU-less CI runner does;
  `pnpm test:e2e:gpu` runs the same specs about four times faster on a Mac.
- The full e2e suite takes 10+ minutes even on the GPU, so run it only when
  asked. Otherwise run the specs a change touches: `pnpm test:e2e:gpu <file>`.
- Playwright reuses any server already on port 5199, including one another
  worktree's run left behind, and then tests that checkout's code. Check with
  `lsof -iTCP:5199 -sTCP:LISTEN`, and set `E2E_PORT` to a free port if it is taken.
- Full-stack dev is `pnpm dev:worker` plus
  `SATVIS_API_PROXY=http://localhost:8080 pnpm dev`. Plain `pnpm dev` proxies
  `/api` to <https://satvis.space>.
- A fresh `git worktree` has no submodules. Run `git submodule update --init`, or
  `data/models` stays empty and `generate-groups` warns that no satellite gets a
  public model. `data/models` is its own package: `pnpm build` there rebuilds the
  models from `build.yaml` (see its README).

## Conventions

- `noUnusedLocals` and `noUnusedParameters` are on; prefix a deliberately unused
  variable with `_`.
- Component names in templates are kebab-case.
- `pnpm lint:fix` formats (`oxfmt`) and sorts imports.
- Comments say only what the code cannot: a constraint, a library quirk, a unit, a
  measured number, a rejected alternative.
- A doc on a declaration is `/** */`, exported or private: module-level declarations,
  class and interface members (`#private` ones too), entries of module-level objects,
  every function, and what a store or composable returns. Everything inside a
  function body is `//`, as are notes on a group of declarations and file headers
  (the split of Google's TypeScript guide: readers of the code versus its internals).
  Prose only, no JSDoc tags.
- Keep private plugins in `data/custom/` out of commits; only
  `example/satvis.yaml` and the sync script there are tracked.

## Gotchas

- **Probes read the answer, not the status.** `pnpm dev` answers a missing file
  with `index.html` and a 200, and a ranged request for one with a 206 and
  `content-type: text/html`, so `response.ok` alone reports success exactly where
  a probe should fail. Where the answer is known at build time, use a `define`
  (`__IMAGERY_MAX_LEVEL__` in `vite.config.ts`). Otherwise check the content type
  and use a ranged `GET`, not a `HEAD`: the Cache API ignores non-GET requests, so
  a `HEAD` misses the service worker's caches (`src/config/starMaps.ts`).
- **`public/404.html` is load-bearing.** It keeps not-found handling in the asset
  router, so a missing file never becomes a billed Worker invocation. `/ot` is a
  `_redirects` 200 rewrite to `/`, not a second html file that could drift.
- **`navigateFallbackDenylist` affects navigations only.** Workbox skips requests
  whose mode is not `navigate`, so the list never changes what a `fetch()`
  receives — only what opening a data url directly shows. `/api/`, `/data/` and
  `/cesium/` are denylisted by prefix because the extension list missed `.json`.
- **No service-worker cache for ion or Google tiles.** Cesium's terms allow
  caching only as a general mechanism, and Google's Map Tiles policies restrict
  caching `tile.googleapis.com`. Neither host may appear in `dist/sw.js`.
- **The committed Cesium ion token is restricted to satvis.space.** ion rejects it
  on localhost, `deploy:preview` origins and foreign iframes, so local work on
  terrain or surface models needs an unrestricted `VITE_CESIUM_ION_TOKEN`
  (`src/config/ion.ts`).
- **Dev and preview are cross-origin isolated; production is not.** The COOP/COEP
  headers in `vite.config.ts` expose `performance.measureUserAgentSpecificMemory()`
  to the benchmark panel. Symptom to recognise: a **black globe with the
  satellites still drawing** means the isolated page refused a worker script the
  service worker cached without a COEP header — clear that origin's service worker.
  More in `src/modules/benchmark/README.md`, "Cross-origin isolation".
- **`HTTP 522` on every CelesTrak source is CelesTrak firewalling Cloudflare's
  shared egress**, not a Cloudflare fault — celestrak.org is not behind Cloudflare.
  That is why the deployed Worker has no cron, and the data arrives through
  `pnpm --filter satvis-worker push-gp` (README, "Downloading off-Worker").
- **Run `pnpm update-imagery` before `pnpm deploy`.** `data/imagery/` levels 0–2
  are committed and 3–5 are generated; the build only warns when they are missing,
  and ships a globe capped at level 2.
- **KV is empty after a first deploy** until the first `push-catalog` and `push-gp`,
  or their on-Worker equivalents, `POST /api/upstream/refresh` and `POST /api/refresh`.
  Nothing scheduled fills it. If a push job stops, `/api/status` marks what it feeds
  `stale`, and nothing else complains.
- **Everything under `data/` ships,** except `data/custom/` (only its synced
  `dist/`) and the models repo (only `data/models/public/`). That is why the
  generators live under `scripts/`. The Docker image builds in whatever plugins
  the checkout has, so an image built with private plugins must stay private.
