# Benchmarking framework

The framework answers three questions repeatably:

- How does the frame cost scale with the number of satellites?
- What does each satellite component cost on top of the ones already drawn?
- What does a faster clock (more frequent propagation) cost?

## Run it

Open **Render menu → Measurement → Benchmark**, or add `?bench=true` to the url
(`cesium.showBenchmark`). Opening the panel loads the framework and installs
`window.bench` for the console.

Measure a production build. A dev build is unminified and runs Vue in development
mode, so its numbers are pessimistic:

```bash
pnpm build && pnpm preview
```

Then use the panel, or the console:

```js
bench.quick(); // 3 counts × 8 isolated sets: checks the harness
bench.run(); // 5 counts × 8 isolated sets: each component's own cost
bench.cumulative(); // 5 counts × 9 growing sets: cost on top of what is already drawn
bench.clock(); // 5 counts × 4 clock rates: the propagation axis
bench.run({ satelliteCounts: [0, 500, 5000], componentSets: [["Point", "Orbit"]] });
bench.run({ clockMultipliers: [1, 100] }); // any sweep can take the clock axis
bench.run({ groundStation: { lat: 48.18, lon: 11.75 } }); // switches pass prediction on
bench.run({ tag: "Starlink" }); // pins the population
bench.run({ captureFootprint: true }); // absolute memory per step, ~17 s each
bench.run({ repeatFirstStep: false }); // skips the closing drift check
bench.watch(); // logs a live line every 2 s; returns a stop function
bench.cancel();
bench.log();
bench.csv();
bench.json();
bench.text();
```

Every sweep ends with a re-run of its first step. A step costs
`warmupMs + sampleMs` (2 s + 4 s by default) plus its build.

Keep the tab in the foreground. A hidden tab presents no frames.

## What it measures

A step is one point in the sweep **satellite count × component set × clock
rate**. The clock axis is ×1 only, unless you ask for more.

| Column             | Meaning                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `fps`, `frameMs`   | Time between presented frames. Flattens against vsync                        |
| `cpuMs`            | `preUpdate` → `postRender`: the render only                                  |
| `tickMs`           | `clock.tick()`, every `onTick` listener included. Propagation shows here     |
| `gpuMs`            | GPU time per frame, blank when the driver's timer is not believable          |
| `p95`, `worst`     | Percentiles of `frameMs`                                                     |
| `frames`           | Sample size. Read it first: rows under 20 frames are noise                   |
| `jankPct`          | Share of frames slower than 33 ms                                            |
| `clock`            | Clock rate, as a multiple of real time                                       |
| `buildMs`          | Wall time to a **complete** scene, spread over frames                        |
| `clearMs`          | Teardown of the previous scene                                               |
| `visible`          | Satellites drawn, which can differ from the count requested                  |
| `drawn`            | Components drawn, when they differ from the ones requested                   |
| `heapMb`           | Heap low-water mark. Input to the memory fit, csv/json only                  |
| `heapPeakMb`       | High-water mark. `heapPeakMb - heapMb` is the allocation rate. csv/json only |
| `footprintMb`      | Absolute JS footprint, garbage excluded. Only with `captureFootprint`        |
| `footprintTotalMb` | JS plus DOM and workers. csv/json only                                       |

### Scaling

A least-squares fit of main-thread time (`cpuMs + tickMs`) against `visible`, per
series (component set **and** clock rate). It reports ms per 1,000 satellites, the
cost at zero, r², the frame-time **floor**, and `satsAt60fps`.

Read `floor` before `satsAt60fps`. The floor is GPU work plus the vsync wait,
which `frameMs` cannot separate. A floor past 16.7 ms means 60 fps was gone
before the first satellite, so `satsAt60fps` is blank.

The fit uses the sum because neither part works alone:

- `cpuMs` misses most of the per-satellite cost. Cesium's `Viewer` runs
  `dataSourceDisplay.update` (every entity's position) in an `onTick` listener,
  before `preUpdate`. A fit of `cpuMs` had the Point series holding 60 fps to
  **1.66 million** satellites, while the frame at 5,000 was already 14.9 ms.
- `frameMs` is quantised by vsync. On a 120 Hz display with points only, from 0
  to 1,000 satellites main-thread work went 0.64 → 1.21 ms while `frameMs` stayed
  at 8.33 ms, so a fit reads a slope of **zero**. At 5,000 satellites with 11.5 ms
  of main-thread work, the median frame was 8.72 ms and the mean of 11.72 ms meant
  "15.5% of frames missed a tick".

The sum is continuous: 0.64, 0.96, 1.21, 6.25, 8.95, 11.52 ms over 0 → 5,000
points. With points only, `cpuMs + tickMs` against `frameMs` was 1.06 of 8.66 ms
at zero satellites and **14.65 of 14.90 ms** at 5,000. The fixed floor is GPU
work. The part that grows with the count is main-thread work, almost all of it
the tick.

`satsAt60fps` is a main-thread ceiling and assumes the GPU is not the limit. At
5,000 points main-thread work was 11.52 ms and the frame 11.72 ms, so the GPU
overlapped it. A bigger canvas, or MSAA and HDR at full device pixels, raises the
floor; the floor column shows it.

**The empty scene is GPU-bound.** On an M4 Pro at 2560×1440 with zero satellites,
`frameMs` was 14.3 ms and `cpuMs` 0.74 ms. Ablation put nearly all of the rest in
two full-screen per-pixel costs: **4× MSAA** (Cesium's default) and
**`highDynamicRange`** (set in `createViewer.ts`). `quality: high` renders at full
device pixels, which quadruples both on a Retina display. Atmosphere, fog, globe
lighting and sun/moon/starfield together came to under 1.5 ms. A component that
is cheap on the CPU but adds fragments looks free in the marginal-cost table and
still costs frames. Read `gpuMs` beside `cpuMs`; where `gpuMs` is blank, compare
`frameMs` with the display's fastest interval.

**Worker replies are outside both regions.** Propagation runs in a worker, and
the main thread handles its replies in a separate task, inside neither
`clock.tick()` nor `preUpdate` → `postRender`. That work lands only in `frameMs`.
At 5,000 satellites and ×100000: `frameMs` 106.1, `cpuMs` 0.86, `tickMs` 3.44,
`gpuMs` 17.8 — about 85 ms unattributed, at 9.4 fps. Below about ×1000 the
residue is small. Above it, treat `cpuMs + tickMs` as a floor and read `frameMs`
beside it. The reply handler is the suspect, not a confirmed cause; a profile is
needed to find out.

### Marginal cost

Each set is differenced against its largest strict subset measured at the same
count and clock, on `cpuMs + tickMs`. In a cumulative sweep that is the cost of the
component just added. In an isolated sweep it is the component's cost over Point.

### Propagation

Each clock rate is differenced against ×1 for the same scene, on `tickMs`, with
`cpuMs` beside it for contrast. The table appears only when the clock was swept.

`cpuMs` cannot see propagation. At 5,000 points at ×10000 (2.2 fps, 462 ms
frames) a `cpuMs` delta read **−0.08 ms**, while instrumentation put 95% of wall
time in `SampledTrajectory.update`.

The clock rate is a propagation axis because `SampledTrajectory` refreshes its
window on a **simulation-time** callback, every quarter orbit, re-propagating 120
SGP4 samples per orbit. Refreshes per wall second scale with the multiplier: at
×1000 a quarter orbit passes in about 1.5 s. Drawing does not depend on the clock.
A `usPerSatellite` that is steady across counts at one rate means the cost is
per-satellite propagation.

### Drift

The first step is re-run at the end and compared with the original. Shader caches,
the JIT and the heap change over a sweep of several minutes. A `mainDriftPct` over
10% (and over 1 ms) means the app moved under the sweep; the panel and `logRun`
warn. The repeat is excluded from every other table. `buildDriftPct` is usually
strongly negative (see `buildMs` below).

### Memory

A least-squares fit of the heap floor against `visible`, per series: MB per 1,000,
KB per satellite, and r². Chrome only. It is a slope, not a footprint. **Read r²
first.**

`usedJSHeapSize` counts uncollected garbage, and script cannot force a
collection. A single reading per step read 86 MB and 462 MB on two passes over the
same scene. That garbage is a roughly common offset across one series in one pass,
so it lands in the intercept. Against forced collections over CDP the fit read
**53.7 KB per satellite against 52.5**, r² 0.999.

A major collection between two rows of a series breaks the fit. On such a pass
(zero-satellite floor 419 MB, next row 101 MB) it read **−2.8 MB per 1,000**
with r² **0.002**. `memoryFitTrustworthy` needs r² ≥ 0.9 and at least 3 counts
(`MIN_MEMORY_FIT_POINTS`): two points always fit with r² 1.0. On failure the panel
marks the row and `logRun` warns; re-run the sweep.

There is no heap drift column: on healthy runs the floor moved −14.6%, −10.2% and
+638%.

**Absolute footprint.** `captureFootprint` (panel: settings → extras) adds a
figure per step from `performance.measureUserAgentSpecificMemory()`, with garbage
excluded. The panel then shows a `footprint` column and an `absolute`
KB-per-satellite beside the derived one. One run measured 54.4 derived against
54.0 absolute, and the API agreed with a forced collection to 0.2% (52.6 vs 52.7
KB per satellite). The `absolute` column has its own r² and point count, because
a capture can be refused for one step.

The call resolves only at a natural major collection: **14–19 s, mean 17 s**
over six calls. It does not disturb the frame median (8.33 ms during a call and
idle). The panel estimate includes it: the default panel sweep reads `≈ 0m 38s`
without it and `≈ 2m 20s` with it. It needs cross-origin isolation; where the page
is not isolated the switch is disabled and says why.

**This is the only leak check that works.** On a clean run the first step and its
repeat measured 36.2 and 38.7 MB absolute, where their heap floors read 35.0 and
103.3 MB. Measured with forced collections, the live set after five passes at
5,000 satellites stayed at 40–41 MB, and a 5,000-satellite scene is 287 MB
against 30 MB empty.

## Cross-origin isolation

`measureUserAgentSpecificMemory()` needs `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: credentialless`. `pnpm dev` and `pnpm preview`
send them (`vite.config.ts`); production does not. `require-corp` does not work,
because ion and Google tiles send no CORP headers.

These headers were checked against a control without them. Results were the same
for the imagery hosts (ArcGIS, OSM, VersaTiles, NASA GIBS, Iowa Mesonet), ReEarth
terrain, `api.cesium.com`, `assets.ion.cesium.com` (World Terrain, OSM Buildings)
and `tile.googleapis.com`: all 200, no `blockedReason`. A framed instance runs
unisolated, because COOP does not apply to iframes. `api.maptiler.com` (403) and
ArcGIS terrain (no requests) fail with and without the headers. PostHog under
`credentialless` is not verified.

**Black globe, satellites still drawing.** An isolated document refuses to start
a worker from a cached response without COEP. When it blocks
`createVerticesFromHeightmap.js`, no terrain is built. This was seen, but not
reproduced on purpose. Clear that origin's service worker and caches, and check
for `ERR_BLOCKED_BY_RESPONSE` on that file. Two related facts:

- A service worker replays the stored COOP/COEP headers, so an origin can stay
  isolated after the server stops sending them.
- `pnpm preview` uses the same port in every git worktree, so one worktree's
  service worker caches serve another's build.

To ship isolation to production, also change `cesium-cache`: it runtime-caches
Cesium's workers `CacheFirst` for 30 days, and those cached responses have no COEP.

## Things that will bite you

- **The tab must stay visible.** A hidden tab suspends `requestAnimationFrame`.
  Each frame wait times out after 1 s, so the sweep continues, but the rows are
  noise. Rows under 20 frames are struck through in the panel, `logRun` warns, and
  the environment records `visibility`.
- **`?framems=16` is for a tab that cannot be made visible** (an automated
  browser pane). It replaces `requestAnimationFrame` with a MessageChannel pump
  and drives `resize`/`render` itself. The channel keeps a core busy. Another
  value sets the interval; `0` turns it off. `app.ts` loads it without the panel.
  - `?framems=100` (10 frames a second) saves render work, not the core. A build
    of more than 250 satellites gets 16 ms per frame, so it takes about six times
    as long.
  - The pane must have laid out the tab, or the canvas is 0 px wide and draws
    nothing. The pump warns once.
  - `document.hidden` stays true.
  - `fps` and `frameMs` measure the pump. `cpuMs` and `tickMs` stay readable.
    Compare only pumped runs with pumped runs, and say so when you quote them.
- **The sweep drives `SatelliteManager.reconcile` directly, not the store.**
  `sceneSync` switches Label off above 200 active satellites, so a store-driven
  sweep could not measure labels at 1,000. Do not touch the toolbar during a run.
  `restore()` puts back the store's scene, `requestRenderMode`, `shouldAnimate`
  and the clock multiplier.
- **Render-on-demand is switched off while the panel is open**, because with it on
  frame gaps measure idleness. If you switch it back on, the panel shows a warning.
  A sweep also forces the clock to run.
- **`buildMs` is wall time, not the freeze.** Satellites are built to a per-frame
  budget (`SatelliteManager.#build`), and the step waits for `buildSettled()`. At
  5,000 points a build that blocked for 908 ms in one frame now takes about
  1,450 ms with no frame over 100 ms. To see a freeze, measure the gaps in the rAF
  stream.
- **`buildMs` is always measured at ×1.** The step's clock rate is applied after
  the build, so the warmup absorbs the first refreshes.
- **`buildMs` is not comparable across component sets.** The first pass pays for
  warmup: `Point` at 500 satellites took 3,245 ms to build, and `Point + Orbit` at
  500 after it took 399 ms. Compare `buildMs` down one set's counts only.
  `buildDriftPct` measures the same effect. The cause (satellite.js, trajectory
  sampling or JIT) is not known.
- **`tickMs` wraps `clock.tick`, not an `onTick` listener.** Listeners run in
  registration order, and the ones that matter are registered with the viewer,
  before the panel.
- **`gpuMs` is withheld when the driver's timer is wrong.** On ANGLE/Metal,
  `EXT_disjoint_timer_query_webgl2` reported 49 ms for frames presented every
  14 ms. A row fails when its GPU time exceeds 1.5× its frame interval
  (`GPU_TIMER_TRUST_FACTOR`), and the column blanks when most rows fail. Rejected
  alternatives: `gl.finish()` does not synchronise in Chrome (WebGL runs in a
  separate GPU process), and timing a tight `scene.render()` loop measures
  queueing, not execution.
- **`visible` can exceed the count requested.** Activation matches by name, and
  two catalog entries can share one: asking for 500 drew 501.
- **Not every component applies to every satellite.** Ground track and sensor cone
  depend on the orbit class, and a 3D model needs a model url. Check `visible` and
  `componentInstances` before you trust a flat line.
- **The whole catalog loads before the first step** (`catalog.ensureAll()`).
  Counts are sliced from the sorted names, so the first 500 are stable, but which
  500 depends on the route's preset. Use `tag` to pin the population.
- **Ground stations are off by default.** A station switches pass prediction on
  for every satellite, a large cost unrelated to drawing. Give it its own run.

## Shape

Only `cesiumBenchmarkTarget.ts` knows about Cesium. The rest is pure and
unit-tested (`benchmark.test.ts`, `framePump.test.ts`).

- `frameSampler.ts` — timestamps in, percentiles out.
- `benchmarkPlan.ts` — the sweep matrix.
- `report.ts` — rows, fits, marginal, propagation and drift tables, csv/json.
- `benchmarkRunner.ts` — the loop over a `BenchmarkTarget`.
- `cesiumBenchmarkTarget.ts` — the Cesium-bound target.
- `framePump.ts` — the `?framems` pump.
- `index.ts` — `window.bench`.
- `../../components/BenchmarkPanel.vue` — the panel.

The panel is an async component and the pump is a separate chunk, so neither runs
for a normal visitor. The PWA precache fetches both (about 36 KB), so the panel
works offline.

`CesiumPerformanceStats` (the `showFps` toggle) is separate. It is an independent
check on the panel's fps, and the panel moves down to keep it visible.
