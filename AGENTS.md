# AGENTS.md

Satellite orbit visualization: a Vue 3 + Vite + CesiumJS + Nuxt UI single-page app
in `src/`, with a Cloudflare Worker backend in `worker/` (the `satvis-worker`
workspace package) and a native iOS app in `ios/`.

## Where things are written down

- **`CONTEXT.md`** — the domain glossary. Use its names in code and discussion,
  and sharpen an entry when a term drifts.
- **`README.md`** — before setting up, read its "Setup"; before running the app
  against a local worker, "Full-stack dev"; before deploying, "Deploy"; before
  changing how the data arrives, "Satellite data".
- **`docs/adr/`** — decisions and the alternatives they beat, one file per topic.
  Read the one on an area before changing how it works.
- **`e2e/`** — Playwright specs against the running app: `journeys/` walks the main
  flows through the menus, `regressions/` pins down one past bug each, for what
  needs layout, a GPU or frames. Read `e2e/support/` before writing one: the
  fixtures, the app and menu helpers, and why they count clock ticks (`app.ts`).
- **`worker/src/gp/types.ts`** — the group, preset and satellite-table config
  schema, field by field. Read it before editing the core config,
  `worker/src/config/satvis.core.yaml`, or a plugin's `data/custom/*/satvis.yaml`.
- **`src/modules/benchmark/README.md`** — read it before measuring what a frame
  costs: the benchmark framework, how the frame cost scales, and its traps.
- **`ios/AGENTS.md`** — read it before changing, building or testing anything
  under `ios/`.

## Architecture

- Per-satellite metadata is attached to records **at refresh time**. There is no
  metadata endpoint and no rule matching in the browser: a record either carries
  the bag or the frontend applies its defaults (`src/config/satelliteMetadata.ts`).
- A satellite's 3D model is the `modelFile` its model manifest gives it
  (`data/models/models.yaml`, `data/custom/*/models.yaml`), by NORAD id or by GCAT
  bus, never its name. Records carry it as `model`, with its lower-detail copies,
  and as `modelFile` for apps released before `model`.

## Commands

`package.json` holds the scripts. What it does not say:

- `pnpm lint` covers both packages, but `pnpm test` covers only the frontend —
  the worker suite is `pnpm --filter satvis-worker test`, which also starts
  `wrangler dev` to check the asset routing (`worker/scripts/check-routes.mjs`).
  `pnpm test:build` checks `dist/sw.js` after a build.
- `pnpm update-parity-fixtures` reruns the web code the native app is held to
  (`scripts/parity/`). Rerun it after any change under `src/modules/`,
  `src/config/` or `src/stores/`, which is all it reads; CI fails while the
  committed output is stale.
- The full e2e suite takes 10+ minutes even on the GPU, so run it only when
  asked. Otherwise run the specs a change touches: `pnpm test:e2e:gpu <file>`,
  about four times faster on a Mac than `pnpm test:e2e`'s SwiftShader.
- Playwright reuses any server already on port 5199, including one another
  worktree's run left behind, and then tests that checkout's code. Check with
  `lsof -iTCP:5199 -sTCP:LISTEN`, and set `E2E_PORT` to a free port if it is taken.
- A fresh `git worktree` has no submodules. Run `git submodule update --init`, or
  `data/models` stays empty and `generate-groups` warns that no satellite gets a
  public model; restart a dev server started before the init, which keeps answering
  `.glb` requests with `index.html`.

## Conventions

- Comments say only what the code cannot: a constraint, a library quirk, a unit, a
  measured number, a rejected alternative. Judge density by `src/` as it stood
  before 2025 (commit `f0005ea5`: about 6% comment lines), not by today's files,
  which run about 15%.
- A doc on a declaration is `/** */`, exported or private: module-level declarations,
  class and interface members (`#private` ones too), entries of module-level objects,
  every function, and what a store or composable returns. Everything inside a
  function body is `//`, as are notes on a group of declarations and file headers
  (the split of Google's TypeScript guide: readers of the code versus its internals).
  Prose only, no JSDoc tags.
- Keep the private plugins in `data/custom/` out of commits, their satellites,
  names and models included: `.gitignore` keeps their files out, not what is
  copied from them into tracked ones.

## Gotchas

- **Probes read the answer, not the status.** `pnpm dev` answers a missing file
  with `index.html` and a success status, ranged or not, so `response.ok` alone
  passes exactly where a probe should fail. Use a `define` where the answer is
  known at build time (`__IMAGERY_MAX_LEVEL__` in `vite.config.ts`); otherwise
  copy the probe in `src/config/starMaps.ts`.
- **The committed Cesium ion token works only on satvis.space**
  (`src/config/ion.ts`). Terrain and the surface models on localhost need an
  unrestricted `VITE_CESIUM_ION_TOKEN` in the gitignored `.env.development`, which
  a fresh `git worktree` lacks: copy the main checkout's.
- **Dev and preview are cross-origin isolated; production is not** (COOP/COEP in
  `vite.config.ts`). Symptom to recognise: a **black globe with the satellites
  still drawing** in a visible tab means the isolated page refused a worker script
  the service worker cached without a COEP header — clear that origin's service
  worker. A hidden tab, such as an agent's browser pane, gets no frames, so what
  it shows proves nothing. More in `src/modules/benchmark/README.md`,
  "Cross-origin isolation" and "Things that will bite you".
- **Everything under `data/` ships,** except `data/custom/` (only its synced
  `dist/`) and the models repo (only `data/models/public/`). That is why the
  generators live under `scripts/`.
