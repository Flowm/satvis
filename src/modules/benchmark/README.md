# Benchmarking framework

The framework runs two kinds of benchmark, both lists of steps (ADR 0016):

- **Scene runs** measure the route's benchmark scenes, the same ones the native app
  runs, and report them in the schema both apps send. They answer what the web app
  costs against the native app on one device.
- **Sweeps** answer three questions repeatably, in both apps:
  - How does the frame cost scale with the number of satellites?
  - What does each satellite component cost on top of the ones already drawn?
  - What does a faster clock (more frequent propagation) cost?

## Run it

Open **Menu → Graphics → Measurement → Benchmark**, or add `?bench=true` to the url
(`cesium.showBenchmark`). Opening the panel loads the framework and installs
`window.bench` for the console. The Scenes tab runs the scenes ticked, all of them
with the drift repeat; a measured row opens for the rest of its figures. The Sweep tab
runs a sweep of the counts, components and clock rates it is given; the named sweeps
and every other option are the console's. The header's status line says where
a run is, whoever started it, the console included. The native app's panel has the same
options and wording.

Measure a production build. A dev build is unminified and runs Vue in development
mode, so its numbers are pessimistic:

```bash
pnpm build && pnpm preview
```

Then use the panel, or the console:

```js
await bench.scenes(); // every scene, then the first again: resolves to the report
await bench.scenes({ only: ["default_view", "starlink_points"] }); // no drift repeat
bench.report; // the last scene run's report
bench.send(); // sends it as the PostHog `benchmark` event, as the panel's Send does
bench.quick(); // 3 counts × 8 isolated sets: checks the harness
bench.run(); // 5 counts × 8 isolated sets: each component's own cost
bench.cumulative(); // 5 counts × 9 growing sets: cost on top of what is already drawn
bench.clock(); // 5 counts × 4 clock rates: the propagation axis
bench.run({ satelliteCounts: [0, 500, 5000], componentSets: [["Point", "Orbit"]] });
bench.run({ clockMultipliers: [1, 100] }); // any sweep can take the clock axis
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

Every run ends with a re-run of its first step. A sweep step costs
`warmupMs + sampleMs` (2 s + 4 s by default) plus its build, a scene 3 s + 5 s plus
its load.

`?bench=run` opens the panel and runs the scenes once the page has loaded;
`&benchscenes=<id>,<id>` runs only those. The url reads `bench=true` from the start
of the run, so a reload, a bookmark or Recent starts none, and the run never sends:
it logs the report and sets `bench.report`. It is the one handle on Safari added to
the Home Screen, which has no console.

Keep the tab in the foreground. A hidden tab presents no frames.

## Scene runs

The scenes are the preset's `benchmark:` list in the worker config
(`worker/src/config/satvis.core.yaml`), written like featured bookmarks: an `id`, a
`name`, a `query` against the preset's defaults, and `paced` for a scene measured
idle. A preset without a list is served the default preset's, which keep the route
`/`: `bench.scenes()` on another route opens `/?bench=run` instead. Keep an `id` when
renaming a scene, so its reports stay comparable; the report carries the definitions
it ran.

A step opens the scene's link (keeping `pixelratio`, `framerate`, `msaa` and `fps`),
waits until everything active is drawn and the count has held for 2 s (90 s at most,
then measured anyway as `timed_out`), deselects, settles 3 s and records 5 s. An
unpaced scene switches render-on-demand off; a paced one keeps it on, so its frame
rate is low by design and `load_pct` is its cost. At the end the view the run found
comes back.

**Idle frames run on a slower GPU.** Paced at under half the display's rate, a
recording is `idle`: the GPU clocks down between frames and times each 1.7 to 2 times
slower than drawn every frame. In Chromium on a Mac the same frame read 28 ms idle and
17 ms while dragging; plain WebGL, without Cesium, showed it too. So idle,
`over_budget_pct` and `load_pct` count the CPU alone, and `gpu_ms` is still reported, but
read it only against other idle recordings. Dragging a paced globe draws every frame and
is not idle.

The report is one flat set of PostHog properties: the environment (`app_`,
`device_`, with `app_frame_rate` as `30`, `60` or `max` and `app_frame_budget_ms` the
budget it gives on that display), `benchmark_version` (8), `benchmark_platform`, `benchmark_scenes`,
`benchmark_definitions`, `benchmark_drift_pct`, and `scene_<id>_<metric>` per step.
The metrics are defined once, by `summarize` in `frameSummary.ts`; the native app is
held to it by a parity fixture (`pnpm update-parity-fixtures`).

| Metric                       | Meaning                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `fps`                        | Drawn frames a second                                                                              |
| `cpu_ms`, `cpu_p95_ms`       | The whole frame callback, clock tick and render, per drawn frame                                   |
| `gpu_ms`, `gpu_p95_ms`       | GPU time per frame, empty without a believable timer                                               |
| `over_budget_pct`            | The larger side's share of frames whose work outlasted the frame budget; idle, the CPU's           |
| `cpu_total_pct`              | Every thread's CPU, in % of one core; a floor on the web                                           |
| `cpu_busy_pct`               | The CPU's busy share, skipped frames included: load's floor where GPU is unknown                   |
| `load_pct`                   | The busier side's share, only when both are known; idle, the CPU's                                 |
| `memory_mb`, `memory_source` | `js_heap` on the web, `phys_footprint` on iOS: never compare the two                               |
| `satellites`, `load_s`       | Satellites drawn, and the time to load the scene                                                   |
| `idle`                       | Paced, frames over two refreshes apart: `gpu_ms` read at the idle clock, budget and load the CPU's |
| `x_<name>`                   | One app's own figures: the web's `tick_ms`, `render_ms` and `gpu_capped_pct`, iOS's waits and more |

`x_gpu_capped_pct` above 0 says the web's GPU was saturated: those frames' times were
capped at the median interval (`gpuCapMs`), so `gpu_ms` reads short of the work.

Compare the two apps row by row on one device. Safari has no GPU timer, so its
`load_pct` is empty; compare `cpu_ms` and `cpu_busy_pct` then.

## The performance panel

`?fps=true` shows the compact panel: the frame rate with a dot coloured by load, heap
and satellites, and meters for CPU and GPU time, whose tick is the frame budget, and for
load. `?fps=graph` adds the last 5 s: each frame's CPU bar over a pale column of its GPU
time, against the labelled budget, paced or not, with each side's p95 marked; each side's
frames split by share of the budget, its red share the over-budget one; then over budget
and total CPU. A tap switches between them. Both widths are fixed. Both read
`FrameMeter` (`frameMeter.ts`), which wraps `CesiumWidget.render`, the clock tick and
the render, and counts a call as a drawn frame only when `postRender` fired in it. Its
averages, over at least 0.5 s and published as a frame is drawn, feed the panel, its
recording a scene step. A GPU time that arrives after its window was published counts
in the next. It measures only while the panel or the benchmark panel is open, and never
changes render pacing: paced, the panel says so, and the load is the figure to read.
Paced means render-on-demand with nothing tracked, as a tracked satellite is drawn every
frame. Load reads "≥ n" where only the CPU side is known. Idle, the GPU meter reads
"idle" over a hatched track and its time stays out of load. The graph marks each frame
idle as it is drawn (paced, more than two display intervals after the one before): its
GPU mark is faded and stays out of over budget, and with only idle frames timed the
footer reads "over, CPU". The native overlay shows the same figures as lines of text,
top right under the corner's buttons, where the web panel sits.

The frame budget is the interval the frame rate asks for, never shorter than the
display's. The web measures the display from the gaps between 60 animation frames: the
shortest gaps that hold half of them, averaged around their median (`displayIntervalMs`). An
iPad loading the page skips refreshes, and the median gap read 25 to 28 ms on its 60 Hz
screen; Safari's late frames leave catch-up gaps of 5 to 14 ms, and its timestamps are whole
milliseconds. A busy iPad mini draws 18 to 24 ms apart, off the refresh, for 20 s and more,
which no rule over gaps can read, so the web measures again every 10 s and whenever frames
come faster than the display it read, keeping the shortest. A screen at 120 Hz whose every
frame takes more than a refresh reads 60 until a lighter moment. The native app takes the
screen's `maximumFramesPerSecond`.

## What a sweep measures

A sweep step is one point in the sweep **satellite count × component set × clock
rate**. The clock axis is ×1 only, unless you ask for more.

The Steps table shows the performance panel's figures, in its order.

| Column                     | Meaning                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `fps`                      | Drawn frames a second. Flattens against vsync and the frame rate cap         |
| `cpuMs`, `cpuP95Ms`        | The frame's main-thread time, tick and render: what sets the frame rate      |
| `gpuMs`, `gpuP95Ms`        | GPU time per frame, blank when the driver's timer is not believable          |
| `loadPct`, `cpuBusyPct`    | The busier side's share; the CPU's alone is load's floor where GPU is blank  |
| `overBudgetPct`            | The larger side's share of frames whose work outlasted the frame budget      |
| `cpuTotalPct`              | Every thread's CPU over the step, in % of one core; a floor on the web       |
| `x_tick_ms`, `x_render_ms` | `clock.tick()` and the render alone. Web extras                              |
| `frames`                   | Sample size. Read it first: rows under 20 frames are noise                   |
| `clock`                    | Clock rate, as a multiple of real time                                       |
| `buildMs`                  | Wall time to a **complete** scene, spread over frames                        |
| `clearMs`                  | Teardown of the previous scene                                               |
| `visible`                  | Satellites drawn, which can differ from the count requested                  |
| `drawn`                    | Components drawn, when they differ from the ones requested                   |
| `heapMb`                   | Heap low-water mark. Input to the memory fit, csv/json only                  |
| `heapPeakMb`               | High-water mark. `heapPeakMb - heapMb` is the allocation rate. csv/json only |
| `footprintMb`              | Absolute JS footprint, garbage excluded. Only with `captureFootprint`        |
| `footprintTotalMb`         | JS plus DOM and workers. csv/json only                                       |

The mean frame interval is kept off the rows; the scaling floor reads it.

### Scaling

A least-squares fit of CPU time (`cpuMs`, the tick included) against `visible`, per
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
points. With points only, the frame's CPU time against `frameMs` was 1.06 of 8.66 ms
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
residue is small. Above it, treat `cpuMs` as a floor and read `frameMs`
beside it. The reply handler is the suspect, not a confirmed cause; a profile is
needed to find out.

The figures above predate the frame meter, which times the tick and the render as one
`cpuMs`; the web's split is in the extras `tick_ms` and `render_ms`.

### Marginal cost

Each set is differenced against its largest strict subset measured at the same
count and clock, on `cpuMs`. In a cumulative sweep that is the cost of the
component just added. In an isolated sweep it is the component's cost over Point.

### Propagation

Each clock rate is differenced against ×1 for the same scene, on `cpuMs` and on
total CPU, which includes the workers. The table appears only when the clock was swept.

The render alone cannot see propagation. At 5,000 points at ×10000 (2.2 fps, 462 ms
frames) its delta read **−0.08 ms**, while instrumentation put 95% of wall
time in `SampledTrajectory.update`.

The clock rate is a propagation axis because `SampledTrajectory` refreshes its
window on a **simulation-time** callback, every quarter orbit, re-propagating 120
SGP4 samples per orbit. Refreshes per wall second scale with the multiplier: at
×1000 a quarter orbit passes in about 1.5 s. Drawing does not depend on the clock.
A `usPerSatellite` that is steady across counts at one rate means the cost is
per-satellite propagation.

### Drift

The first step is re-run at the end and compared with the original. Shader caches,
the JIT and the heap change over a sweep of several minutes. A `cpuDriftPct` over
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

**Absolute footprint.** `captureFootprint` (console only) adds a
figure per step from `performance.measureUserAgentSpecificMemory()`, with garbage
excluded. The panel then shows a `footprint` column and an `absolute`
KB-per-satellite beside the derived one. One run measured 54.4 derived against
54.0 absolute, and the API agreed with a forced collection to 0.2% (52.6 vs 52.7
KB per satellite). The `absolute` column has its own r² and point count, because
a capture can be refused for one step.

The call resolves only at a natural major collection: **14–19 s, mean 17 s**
over six calls. It does not disturb the frame median (8.33 ms during a call and
idle), but adds that much to every step. It needs cross-origin isolation, which only
dev and preview have.

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
unisolated, because COOP does not apply to iframes. `api.maptiler.com` (403) fails
with and without the headers. PostHog under `credentialless` is not verified.

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
    gets 16 ms per frame, so one that spans frames takes about six times as long.
  - The pane must have laid out the tab, or the canvas is 0 px wide and draws
    nothing. The pump warns once.
  - `document.hidden` stays true.
  - `fps` and `frameMs` measure the pump. `cpuMs` and `tickMs` stay readable.
    Compare only pumped runs with pumped runs, and say so when you quote them.
- **The sweep drives `SatelliteManager.reconcile` directly, not the store.**
  `sceneSync` switches Label off above 200 active satellites, and 3D model above 200
  with a model, so a store-driven sweep could not measure them at 1,000. Do not touch the toolbar during a run.
  `restore()` puts back the store's scene, `requestRenderMode`, `shouldAnimate`
  and the clock multiplier.
- **A sweep switches render-on-demand off**, because with it on frame gaps measure
  idleness, and forces the clock to run. A scene run follows each scene's `paced`.
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
- **A saturated GPU's times are capped at the frame interval.** On ANGLE/Metal,
  `EXT_disjoint_timer_query_webgl2` counts a frame's wait in the queue as well as
  its work: 49 ms for frames presented every 14 ms, and 37 ms for 19 ms of work
  drawn every frame. Where the mean GPU time of half a second, a recording or the
  graph's 5 s outruns its median frame interval (`gpuCapMs`), each time is capped
  at that interval, as a GPU keeping pace spent at most that on a frame: the GPU
  then reads the budget and load 100 %. Where over half are capped, the panel
  marks the GPU figure "≤": a ceiling, not a floor. Saturated, the GPU spends the
  whole interval on each frame, so uncapped it is the cost at full clock; at a
  capped frame rate it may have clocked down to fill the frame, and then reads
  16.6 ms at 60 fps for about 13 ms of work at full clock. Withholding GPU time for the page's life
  instead, once it overran, blanked it on the first drag of a large canvas until a
  reload. Rejected
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
- **Only ground station links bring a station.** A step with them adds the
  benchmark's station (`SWEEP_GROUND_STATION`), which they need to draw, and so
  pays for predicting the passes of every satellite it shows.

## Shape

Only `cesiumBenchmarkTarget.ts`, the frame meter and the pump know about Cesium. The
summary, plan, reports and runner are pure and unit-tested (`benchmark.test.ts`,
`frameSummary.test.ts`, `benchmarkReport.test.ts`, and `benchmarkRunner.test.ts` with a
fake target), as is the pump's frame queue (`framePump.test.ts`).

- `frameMeter.ts` — what every frame costs, for the performance panel and the steps.
- `frameSummary.ts` — a recording in, the comparable metrics out.
- `sweepResults.ts` — a web sweep step as both apps' tables read it.
- `benchmarkPlan.ts` — the scene steps and the sweep matrix.
- `benchmarkReport.ts` — the scene run's report, as both apps send it.
- `report.ts` — a sweep's rows, fits, marginal, propagation and drift tables, csv/json.
- `benchmarkRunner.ts` — the loop over a `BenchmarkTarget`.
- `cesiumBenchmarkTarget.ts` — the Cesium-bound target.
- `framePump.ts` — the `?framems` pump.
- `index.ts` — `window.bench`.
- `../../components/PerformancePanel.vue` and `../../components/benchmark/` — the panels.

The panels are async components and the pump is a separate chunk, so none runs for a
normal visitor. The PWA precache fetches them, so the panels work offline.
