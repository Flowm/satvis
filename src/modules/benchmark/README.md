# Benchmarking framework

Three questions about satvis's performance, answered repeatably:

> How does the frame cost scale with the number of satellites, what does each
> satellite component cost on top of the ones already being drawn, and what does
> running the clock faster — that is, propagating more often — cost?

It replaces the console-paste script that used to be `src/modules/benchmark.ts`,
which measured average and worst frame time and printed one line per step. The
same idea, with the parts that made its numbers hard to trust fixed: percentiles
instead of an average and a max, warmup frames discarded, a build torn down
before the next one is timed, the first step re-run at the end to catch drift,
and what was _actually drawn_ recorded next to what was asked for.

## Run it

**Render menu → Measurement → Benchmark**, or `?bench=true` in the url. They are the same switch:
it is `cesium.showBenchmark`, url-synced like every other switch in that menu, so a
benchmarking session is a shareable link.

Opening the panel is what loads the framework, and that is also what puts
`window.bench` there for console use.

**Measure a production build, not `pnpm dev`** — a dev build is unminified and runs
Vue in development mode, so its numbers are pessimistic by an unknown factor:

```bash
pnpm build && pnpm preview
```

Then the panel, or the console:

```js
bench.quick(); // 3 counts × 7 isolated sets — checks the harness
bench.run(); // 5 counts × 7 isolated sets: each component's own cost
bench.cumulative(); // 5 counts × 8 growing sets: cost on top of what is already drawn
bench.clock(); // 5 counts × 4 clock rates: the propagation axis
bench.run({ satelliteCounts: [0, 500, 5000], componentSets: [["Point", "Orbit"]] });
bench.run({ clockMultipliers: [1, 100] }); // any sweep can take the clock axis
bench.run({ groundStation: { lat: 48.18, lon: 11.75 } }); // switches pass prediction on
bench.run({ captureFootprint: true }); // absolute memory per step, ~17 s each
bench.run({ repeatFirstStep: false }); // skip the closing drift check
bench.watch(); // log a live line every 2 s; returns a stop function
bench.cancel();
bench.log();
bench.csv();
bench.json();
bench.text();
```

Every sweep closes by re-running its first step, so the step count is one more
than the axes multiply out to. A step costs `warmupMs + sampleMs` (2 s + 4 s by
default) plus its build, which is what keeps the default counts down to five.

Keep the tab in the foreground. A background tab presents no frames at all and
every row becomes a lie — see the first caveat below.

## What it measures

A step is one point in a three-axis sweep: **satellite count × component set ×
clock rate**. The clock axis is one value (×1) unless asked for, so it costs
nothing when the question is only about drawing.

| Column             | Meaning                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `fps`, `frameMs`   | Between presented frames. What the user feels; flattens against vsync at 60/120 fps          |
| `cpuMs`            | `preUpdate` → `postRender`. The render only — position updates are in `tickMs`               |
| `tickMs`           | `clock.tick()`, every `onTick` listener included. Where propagation shows up                 |
| `gpuMs`            | GPU time per frame, where the driver's clock can be believed. Blank otherwise                |
| `p95`, `worst`     | Percentiles, not just a max — one 400 ms frame should not define a row                       |
| `frames`           | The sample size. A handful means the row is noise; read this one first                       |
| `jankPct`          | Share of frames slower than 33 ms                                                            |
| `clock`            | The clock rate the step ran at, as a multiple of real time                                   |
| `buildMs`          | Wall time to a **complete** scene: instantiation plus component creation, spread over frames |
| `clearMs`          | Tearing the previous scene down                                                              |
| `visible`          | Satellites actually drawn, which is **not** always the count requested                       |
| `drawn`            | Components actually drawn, when they differ from the ones requested                          |
| `heapMb`           | Heap low-water mark. **Not printed** — an input to the memory fit. csv/json only             |
| `heapPeakMb`       | High-water mark. `heapPeakMb - heapMb` is the window's allocation rate. csv/json             |
| `footprintMb`      | Absolute JS footprint, garbage excluded. Only with the footprint switch on                   |
| `footprintTotalMb` | The whole agent — JS plus DOM and workers. Broader, and csv/json only                        |

And derived, across steps:

- **scaling** — a least-squares fit of main-thread frame time, meaning
  `cpuMs + tickMs`, against the satellites drawn, per _series_ (component set
  **and** clock rate, so a fit is never averaged across clocks): ms per 1,000
  satellites, the fixed cost at zero, r² (well under 1.0 means the cost is _not_
  linear in the count), the frame-time **floor**, and where 60 fps runs out.

  Read `floor` before `sats@60`. The floor is everything outside the main thread —
  GPU work and the wait for vsync, which `frameMs` cannot separate — and it is the
  term that decides whether the slope matters at all. A floor already past 16.7 ms
  means 60 fps was gone before the first satellite, and `sats@60` goes blank
  rather than extrapolating a count that was never the problem.

  Neither obvious candidate works as the fit basis, which is why it is the sum:

  - `cpuMs` alone misses most of the per-satellite cost. Cesium's `Viewer` runs
    `dataSourceDisplay.update` — every entity's position evaluation — inside an
    `onTick` listener, before `preUpdate`. Fitting it had the Point series holding
    60 fps to **1.66 million** satellites while the measured frame at five
    thousand was already 14.9 ms.
  - `frameMs` cannot be fitted at all, because vsync quantises it. Measured on a
    120 Hz display with points only: from 0 to 1,000 satellites main-thread work
    went 0.64 → 1.21 ms and `frameMs` sat at exactly 8.33 ms the whole way, the
    extra work absorbed by idle already being spent waiting for the next tick — a
    fit through it reads a slope of **zero**. Past the interval it stops being
    continuous rather than becoming useful: at 5,000 satellites with 11.5 ms of
    main-thread work, the _median_ frame still presented at 8.72 ms and the mean
    of 11.72 ms really meant "15.5% of frames missed a tick". Its intercept is the
    refresh interval, a property of the display rather than of the app.

  `sats@60` is therefore a **main-thread** ceiling, and it assumes the GPU is not
  the binding constraint. That is what the measurements show once a scene is large
  enough to matter — at 5,000 points, main-thread work was 11.52 ms and the frame
  11.72, so the frame _was_ the main thread and the GPU overlapped it — but a
  bigger canvas or MSAA and HDR at full device pixels raises the floor, and the
  floor column is how you notice.

- **memory** — a least-squares fit of the heap floor against the satellites drawn,
  per series: MB per 1,000 satellites, KB per satellite, and r². Chrome only, and
  a slope rather than a footprint — **read r² first**, because the whole method
  rests on an assumption that can break. See the memory caveat below.

  With **accurate memory footprint** switched on (Render menu → Benchmark →
  settings → extras, or `captureFootprint: true`) each step also gets an absolute
  figure with garbage excluded, from
  `performance.measureUserAgentSpecificMemory()`. That adds a `mem MB` column and
  an `absolute` KB-per-satellite beside the derived one — two independent
  derivations of the same quantity, so agreement is evidence and a gap is a
  question. Measured on one run: 54.4 derived against 54.0 absolute.

  The `absolute` column carries **its own r² and point count**, because a capture
  can be refused for a single step: that leaves it fitted over two points while the
  floor fit beside it still has three, and it would otherwise be printed under the
  floor fit's green r².

  It is off by default because it is the most expensive thing here: the call
  resolves only when a collection happens, about 17 s a step, which the duration
  estimate includes (the default sweep reads `≈ 0m 38s` off and `≈ 2m 20s` on).
  It needs a cross-origin isolated page, which `pnpm dev` and `pnpm preview` serve
  and a deployed satvis.space does not — see
  [Cross-origin isolation](#cross-origin-isolation).
  Where the page is not isolated the switch is disabled and says why.

  **This is also the only leak check that works.** Two absolute figures for one
  scene, minutes apart, are comparable in a way the heap floor is not: on a clean
  run the first step and its repeat measured 36.2 and 38.7 MB, where the floors for
  those same two rows read 35.0 and 103.3 — a 195% swing against a real 7%.

- **marginal cost** — each set differenced against the largest set measured under
  the same conditions that is a strict subset of it, on main-thread frame time. In
  a cumulative sweep that is the cost of the component just added; in an isolated
  sweep it is that component's cost over a bare point. One function serves both.
- **propagation** — each clock rate differenced against ×1 for the same satellites
  and components, on `tickMs`. Only present when the clock was actually swept,
  because an empty table would read as "propagation is free" rather than "nobody
  asked".

  It differenced `cpuMs` until it was pointed at a real question and got it
  wrong. Measured at 5,000 satellites drawing points at ×10000 — a step running
  at 2.2 fps with 462 ms frames — it reported a delta of **−0.08 ms and 0 µs per
  satellite**, because all of the cost was in the clock tick that `cpuMs` starts
  after. Direct instrumentation put 95% of wall time inside
  `SampledTrajectory.update`. The one table named after propagation could not see
  propagation; it now differences `tickMs` and prints `cpuMs` beside it for
  contrast.

  **`tickMs` has the same blind spot one step further out, and this table inherits
  it.** Since propagation moved to a worker, the samples come back in `message`
  events, and what the main thread does with them — resolving the request and
  filing the chunk — runs in its own task, inside neither `clock.tick()` nor
  `preUpdate`→`postRender`. So it lands in `frameMs` and in nothing else.
  Measured at 5,000 satellites and ×100000: `frameMs` 106.1, of which `cpuMs` 0.86,
  `tickMs` 3.44 and `gpuMs` 17.8 — about 85 ms attributed to nothing, at 9.4 fps,
  where it cannot be idle waiting for vsync. Below roughly ×1000 the residue is
  small and this table reads true; above it, treat the figure as a floor and read
  `frameMs` beside it. Identifying the residue needs a profile rather than another
  sweep — the reply handler is the candidate, not a confirmed cause.

- **drift** — the first step, re-run as the last step, against its original.
  A sweep is minutes long and the app it measures does not hold still: shader
  caches fill, the JIT settles, the heap grows. This is the only figure in the run
  that can tell a rising line that is the scene from a rising line that is the
  clock, so a small `mainDriftPct` is what licenses reading the other tables at
  all — over 10% and both the panel and `logRun` say so. The repeat step is
  excluded from every other table: it is a second sample of a scene already in the
  set, and averaging it in would weight one point twice and hide the drift it was
  measured to expose. `buildDriftPct` is usually the louder of the two and
  expected to be strongly negative — see the `buildMs` caveat below.

### Why the clock rate is a propagation axis

Propagation is not paid per frame. `SampledTrajectory.start` refreshes its sample
window on a **simulation-time** callback — every quarter of an orbital period — and
each refresh re-propagates 120 SGP4 samples per orbit for that satellite. So
refreshes per wall second are proportional to the multiplier: at ×1000 a quarter
orbit goes by in about a second and a half, where at ×1 it takes a quarter of an
orbit. Drawing does not care what the clock is doing, which is exactly what makes
the difference between two clock rates attributable to propagation.

A `usPerSatellite` that holds steady across counts at one rate says the cost is
per-satellite propagation and nothing else.

### Cross-origin isolation

`performance.measureUserAgentSpecificMemory()` — the **accurate memory footprint**
switch — is only exposed to a cross-origin isolated page, so it needs
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless`, which `pnpm dev` and `pnpm preview`
both send.

One interaction is unresolved rather than settled: **isolation and this app's service
worker.** An isolated document refuses to start a
dedicated worker from a cached response carrying no
`Cross-Origin-Embedder-Policy`, and `createVerticesFromHeightmap.js` is exactly
such a worker — when it is blocked no terrain geometry is built, the globe is black,
and the satellites go on drawing over nothing. That was observed once directly, with
the blocked request in the network log and a precache entry whose
`cross-origin-embedder-policy` was null, and it was reported again as recurring on
every reload rather than once.

It has not been reproduced deliberately. Four configurations were tried in system
Chrome — a fresh origin over three loads with the precache settled at 116 entries;
the same build isolated and then de-isolated on one origin; a second worktree's
build served on an origin the isolated build had populated; and repeated reloads in
the automated browser pane. All of them rendered the globe with the worker
constructing fine. Two things did come out of the attempt and both matter:

- **A service worker replays the stored `COOP`/`COEP` headers**, so an origin can
  stay isolated after the server stops sending them. Isolation is sticky per origin,
  not per response.
- **The preview port is shared between git worktrees.** A service worker is scoped
  to the origin, so one worktree's build populates caches that another worktree's
  build is then served against — different assets, and now possibly different
  isolation state, behind one registration.

The mechanism is not understood. If the globe goes black while the satellites draw,
clear that origin's service worker and caches — and check whether
`createVerticesFromHeightmap.js` shows `ERR_BLOCKED_BY_RESPONSE`, which is what
separates this from the shared-origin cache mess above.

**Shipping this to production needs more than a `cacheId` bump.** Precache entries
are keyed by content revision and Cesium's workers are copied verbatim between
builds, so a deploy would not re-fetch them — and `cesium-cache` runtime-caches
those same workers `CacheFirst` for 30 days under a name Workbox does not namespace
with `cacheId`. Both would have to change in one release. PostHog under
`credentialless` is also still unverified.

## Things that will bite you

- **The tab has to stay visible.** A hidden tab does not throttle
  `requestAnimationFrame`, it suspends it — no frames are presented at all, and
  every timing becomes noise. The sweep no longer wedges when that happens (each
  frame wait has a 1 s timeout), and it says so instead: `frames` on each row is
  the sample size, rows under 20 frames are struck through in the panel,
  `logRun` warns before the tables, and the run's environment records
  `visibility`. Read `frames` before believing anything else on a row.
- **`?framems=16` is for a tab that cannot be made visible**, which in practice
  means an automated browser pane. It replaces `requestAnimationFrame` with frames
  every 16 ms from a MessageChannel — the one scheduler a hidden page does not
  throttle, where `setTimeout` is clamped to a second and a worker's messages slow
  to one every ~100 ms — and drives `resize`/`render` in place of the viewer's own
  loop, which cannot be restarted once its callback has been suspended. The
  channel keeps a core busy. Another value paces it off 60 Hz; `0` turns it off.

  A test that needs no smooth picture can pace it slower, such as `?framems=100`
  (10 frames a second), and spend less of the main thread on rendering. The core
  stays busy between frames, so this saves render work, not the core. And a build
  of more than 250 satellites gets 16 ms per frame, so at 10 frames a second it
  takes about six times as long.

  It works without the panel: `app.ts` loads it whenever the parameter is there.
  The pane does have to have laid the tab out, or Cesium's canvas is 0 px wide and
  draws nothing however many frames it is given — the pump says so once when it
  sees that, rather than letting a sweep return zeros that look like measurements.
  `document.hidden` stays true, so anything that reads it still sees a hidden page.

  It buys a scene that builds and renders; it does **not** buy a frame rate.
  Frames arrive on a fixed interval of the pump's choosing, so `fps` and
  `frameMs` measure the pump and flatten against its rate exactly as they would
  against vsync. `cpuMs` and `tickMs` are spans inside a frame and do not care
  what scheduled it, so those stay readable. Treat such a run as a comparison
  between two builds, both pumped, and say so wherever the numbers are quoted.

- **The sweep drives `SatelliteManager.reconcile` directly, not the store.** It has
  to: `sceneSync` switches Label off above 200 active satellites, so a
  store-driven sweep could not measure labels at 1,000. The cost is that a store
  change mid-sweep would overwrite the scene — so don't touch the toolbar while
  it runs. `restore()` puts the store's scene, `requestRenderMode` and
  `shouldAnimate` back afterwards.
- **Render-on-demand is switched off as soon as the panel opens**, and put back when
  it closes. With it on, the gap between frames measures how idle the loop is rather
  than what a scene costs, so there is no reading to be had — which is why this is
  not offered as a choice. Switching it back on from the Render menu while the panel
  is open puts a warning across the top of the panel, beside the readout it
  invalidates. The clock is likewise forced to run for the duration of a sweep: a
  stopped clock means no position updates, and position updates are most of the cost.
- **`buildMs` is wall time, not blocking time, and it is not the freeze.**
  Satellites are instantiated to a per-frame budget (`SatelliteManager.#build`),
  so `reconcile` returns with the queue still draining and the step waits on
  `buildSettled()` before measuring — without that wait every row would report
  whatever fraction of the population existed when the first frame ended. The
  consequence is that `buildMs` went **up** when the freeze went away: at 5,000
  satellites a points-only build blocked for 908 ms as one frame and now
  completes in about 1,450 ms with no frame over 100 ms. If what you want is the
  freeze, measure the gaps in the rAF stream; this column cannot see them.
- **`buildMs` is always measured at ×1**, whatever the step's clock rate. A step at
  ×1000 would otherwise sweep the sample window forward mid-build, so the build would
  carry propagation belonging to the measurement after it. The rate is applied once
  the scene is up, so the warmup absorbs the first refreshes at the new rate.
- **`cpuMs` excludes the clock tick; `tickMs` is that tick.** Cesium runs
  `clock.onTick` — where sampled positions update — before `scene.preUpdate`, so
  per-satellite position work lands in `frameMs` but not in `cpuMs`. It is
  measured separately by wrapping `clock.tick` itself rather than by adding an
  `onTick` listener: listeners are raised in registration order and two that
  matter (the manager's derived-geometry refresh, the orbit batch's
  re-orientation) are registered with the viewer, long before the panel, so a
  marker of our own would sit behind them and miss the work it was there to find.
  Read the pair together — `cpuMs` well under `tickMs` is a propagation-bound
  scene, and the reverse is a draw-bound one.

  Neither covers the whole main thread. Worker replies are handled in their own
  task, outside both regions, so `cpuMs + tickMs` can sit far below `frameMs` on a
  scene that is nonetheless main-thread bound — see the propagation table above for
  the measurement and the bound on when it matters.

- **The derived tables fit against `cpuMs`, which is main-thread time only, and
  this app is usually GPU-bound.** Measured on an M4 Pro at 2560×1440 with zero
  satellites: `frameMs` 14.3, `cpuMs` 0.74 — the CPU is 5% of the frame, and the
  remaining ~13.5 ms is fragment work that `scalingFits` and `marginalCosts`
  cannot see. Ablation put nearly all of it in two settings, both full-screen
  per-pixel costs: **4× MSAA** (Cesium's default) and **`highDynamicRange`** (set
  in `createViewer.ts`), with `quality: high` rendering at full device pixels and
  so quadrupling both on a Retina display. Everything scene-shaped — atmosphere,
  fog, globe lighting, sun/moon/starfield — came to under 1.5 ms together.
  So a component that is cheap on the CPU but adds fragments will look free in
  the marginal-cost table and still cost frames. Read `gpuMs` beside `cpuMs`, and
  where `gpuMs` is blank read `frameMs`: if it sits well above the display's
  fastest observed interval, the scene is GPU-bound whatever `cpuMs` says.

  **That is the empty scene, and it stops being true once satellites are drawn.**
  What changes it is `tickMs`: Cesium's `Viewer` runs `dataSourceDisplay.update` —
  every entity visualizer, and so every satellite's position evaluation — inside
  its own `onTick` listener, which is before `preUpdate` and therefore outside
  `cpuMs`. Measured with points and nothing else, `cpuMs + tickMs` against
  `frameMs`: at zero satellites 1.06 of 8.66 ms, at 5,000 satellites **14.65 of
  14.90 ms**. The fixed floor is GPU work; the part that grows with the count is
  main-thread work, and almost all of it is the tick.

  `scalingFits` and `marginalCosts` fit `cpuMs + tickMs` for exactly this reason,
  and report the frame-time floor beside the slope so a GPU-bound configuration is
  visible rather than implied. See **scaling** above.

- **`gpuMs` is withheld rather than guessed when the driver lies.** A frame that
  presented every 14 ms cannot have cost the GPU 49 ms, but that is exactly what
  `EXT_disjoint_timer_query_webgl2` reported on ANGLE/Metal. Every row's figure is
  checked against its own frame interval (`GPU_TIMER_TRUST_FACTOR`, 1.5×) and the
  whole column blanks when most rows fail, with `logRun` saying which of the two
  reasons applies — no extension, or one that cannot be believed. Two other
  approaches were tried and do not work: `gl.finish()` never synchronises in
  Chrome (WebGL is proxied to a separate GPU process), and timing a tight
  `scene.render()` loop measures queueing rather than execution.
- **`buildMs` is not comparable across component sets.** The first pass over a
  population pays for whatever it warms up; a measured run had `Point` at 500
  satellites cost 3,245 ms to build and `Point + Orbit` at the same 500 cost
  399 ms — more drawing, an eighth of the time, because it was second. Compare
  `buildMs` down a column (rising counts within one set), never across sets. The
  drift table quantifies it directly: `buildDriftPct` is that same first-pass cost,
  measured rather than argued about. Whether it is satellite.js, the trajectory
  sampling or plain JIT warmup is the first thing this framework is worth pointing
  at.
- **`visible` may exceed the count requested.** Activation matches by _name_ and
  two catalog entries can share one, so asking for 500 drew 501. That is why the
  fits are computed against `visible` rather than the requested count.
- **Not every component applies to every satellite.** Ground track and sensor cone
  are drawn per orbit class, a 3D model needs a model url. `visible` and
  `componentInstances` are recorded for exactly this reason; check them before
  believing a flat line.
- **Memory is reported as a slope, and the slope has one failure mode.**
  `performance.memory.usedJSHeapSize` counts garbage that has not been collected
  yet, and script cannot force a collection. So a heap reading is not a footprint,
  and the single one this framework used to print per step read 86 MB and 462 MB
  on consecutive passes over the _same_ scene — it sent someone hunting a leak
  that did not exist. The heap is now sampled every frame, the per-step floor is
  kept out of the printed tables (csv and json still carry it), and what is
  reported is `memoryFits`: the floor fitted against the satellites drawn, within
  one series.

  Why a fit works: the standing garbage is roughly a **common offset** across the
  rows of one series measured in one pass, so it lands in the intercept and leaves
  the slope alone. Checked against forced collections over CDP with each scene held
  up, the fit reported **53.7 KB per satellite against a true 52.5** — about 2%
  out, r² 0.999.

  When it does not work: if a major collection lands _between_ two rows of a
  series, the offset stops being common and the slope is meaningless rather than
  merely noisy. Measured on such a pass — zero-satellite floor 419 MB, the next row
  101 MB — the fit reported **−2.8 MB per 1,000 satellites**, memory apparently
  freed by drawing. That is what r² is for and it caught it at **0.002**, against
  0.999 for the good pass. `memoryFitTrustworthy` gates on it, the panel marks the
  row, and `logRun` warns — if you see it, re-run the sweep.

  It also refuses a **two-count sweep** (`MIN_MEMORY_FIT_POINTS`, 3), however
  beautifully it fits: two points always lie on their own line, so r² comes back
  1.000 exactly where the offset assumption has been tested least. Three counts is
  the fewest that can disagree with itself.

  `heapDriftPct` on the drift table is the same scene's floor minutes apart. Treat
  it as a **prompt, not a verdict**: it moves with whenever V8 last collected, and
  measured on two clean runs it read −14.6% and −10.2% with nothing wrong. A large
  figure means go and check with a real collection, not that there is a leak.

  For an absolute number there is no substitute for a collection script cannot ask
  for: DevTools, or `HeapProfiler.collectGarbage` over CDP. Measured that way, the
  live set after five passes at 5,000 satellites was flat at 40–41 MB (nothing
  leaks), and a live 5,000-satellite scene is 287 MB against 30 MB empty. There is
  one accurate in-page alternative, tried rather than assumed:
  `performance.measureUserAgentSpecificMemory()`. It needs cross-origin isolation,
  and `Cross-Origin-Opener-Policy: same-origin` with
  `Cross-Origin-Embedder-Policy: credentialless` isolates this app without breaking
  anything — verified `crossOriginIsolated` true, catalog loaded, 74 satellites
  drawn, no console errors, and still working when framed from a foreign origin
  (COOP does not apply to iframes, so a framed instance runs unisolated as before).
  `credentialless` is required rather than `require-corp`, which would need ion and
  Google tiles to send CORP headers they do not send. Its figure agreed with a
  forced collection to 0.2%: 52.6 KB per satellite against 52.7.

  Every cross-origin consumer was checked against a control differing only in the
  headers, and all of them behaved identically: the five imagery hosts (ArcGIS,
  OSM, VersaTiles, NASA GIBS, Iowa Mesonet), ReEarth terrain, `api.cesium.com`,
  36 tile loads from `assets.ion.cesium.com` under ion World Terrain, 178 more
  under OSM Buildings, and 114 from `tile.googleapis.com` under Google
  photorealistic in the sky view — every status 200, no failures, no
  `blockedReason` on either side. That last one also settles the worry that the
  PWA's `statuses: [0, 200]` rule implied opaque ion responses: they come back
  200, so they are CORS and `credentialless` leaves them alone. Two providers
  fail identically with and without the headers and so are unrelated:
  `api.maptiler.com` answers 403 (its key looks domain-restricted the way the ion
  token is) and ArcGIS terrain makes no requests at all. PostHog is the one
  consumer still unverified.

  What makes it a separate tool rather than a column is its cost. The call resolves
  only after a natural major collection: measured over six calls, **14–19 s each,
  mean 17 s**. It does not perturb what it measures (frame median 8.33 ms both
  during a call and quiet), but at one call per step a 36-step sweep would grow by
  ten minutes. Where it fits is once before and once after a run — about 34 s for
  two real live sets of the same scene, which is the leak check `heapDriftPct`
  could not be — or a short dedicated sweep of three counts for absolute
  footprints.

  Chrome only. Granularity is not the limitation: measured, eight consecutive
  reads give eight distinct non-round values with and without
  `--enable-precise-memory-info`.

- **The whole catalog is loaded before the first step** (`catalog.ensureAll()`), so
  a run measures drawing rather than downloading. Counts are sliced from the sorted
  catalog, so "the first 500" is the same 500 every time — but which 500 depends on
  the route's preset, and their orbit classes decide what can be drawn. Pass
  `{ tag: "Starlink" }` to pin the population.
- **Ground stations are off by default.** One station switches pass prediction on
  for every satellite, which is a large cost that has nothing to do with drawing.
  Give it its own run.

## Shape

One file knows about Cesium. Everything else is pure and unit-tested
(`benchmark.test.ts`), which is what lets the analysis be trusted without a
browser in the loop:

- `frameSampler.ts` — timestamps in, percentiles out. No Cesium, no DOM.
- `benchmarkPlan.ts` — the three-axis sweep matrix, pure.
- `report.ts` — rows, the linear fits (frame time and memory), the marginal-cost,
  propagation and drift differencing, csv/json.
- `benchmarkRunner.ts` — the loop, over a `BenchmarkTarget` interface.
- `cesiumBenchmarkTarget.ts` — the only file that knows what a viewer is.
- `framePump.ts` — frames for a page the browser stopped presenting. Off unless
  `?framems` asks; the queue in it is pure and tested.
- `index.ts` — the console handle, `window.bench`.
- `../../components/BenchmarkPanel.vue` — the in-browser half.

Nothing here runs for a normal visitor: the panel is an async component, so the
whole framework is a chunk that loads only when the switch goes on, and the frame
pump is a chunk of its own that loads only with `?framems`. The PWA precache does
fetch both in the background, about 36 KB of a 9.6 MB precache, which keeps the
panel working offline.

`CesiumPerformanceStats` (behind the `showFps` toggle) is separate and untouched.
It is deliberately not replaced: Cesium's own FPS counter is an independent second
opinion on the panel's headline figure, computed by code this framework does not
own, which is why the panel is positioned to leave it visible.
