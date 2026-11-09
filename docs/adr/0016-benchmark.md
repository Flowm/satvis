---
status: accepted
---

# One benchmark in both apps: scenes on the preset, one step, one report

The two apps measured frames with different benchmarks that used the same words. The web
app (`src/modules/benchmark/`) swept satellite count × component set × clock rate by
calling `SatelliteManager.reconcile` itself, logged its results to the console, and showed
fps through Cesium's own counter. The native app (`Benchmark.swift`) ran eleven fixed
scenes, each a link written in Swift, and sent a PostHog `benchmark` event. The web's
`cpuMs` left out the clock tick, which the native `cpu` includes. Slow frames were frames
over 33 ms on the web and over 1.5 refreshes on iOS. Only iOS had load. The question that
mattered most, what the web app on a device costs against the native app on the same
device, had no answer that compared like with like.

## Decision

**Runs of the same scenes compare row by row on one device, across the two apps.** They
use the same scenes, the same metric definitions and the same report schema. Absolute
numbers across devices are not meant to match, and there is no score.

**Benchmark scenes belong to the preset, in the worker config, written like featured
bookmarks** (ADR 0011). Each preset may list a `benchmark:` beside `featured:`. An entry
has an `id`, a `name` and a `query` against the preset's defaults, with no thumbnail, plus
`paced` (the scene is idle, its frames paced). The `id` is explicit, so renaming a scene keeps it comparable with older
reports. The worker validates the list as it validates `featured`, and serves the default
preset's list on a preset that has none. Each fallback entry keeps its route `/`, so a
missing tag on `/ot` cannot silently measure another population under the same name.
Both apps read the list at runtime, so the scenes can change without an app release. The
report therefore carries the scene definitions it ran, not a version number someone has
to remember to bump. Ten of the eleven iOS scenes moved there unchanged; the report is
version 8. The eleventh measured the ISS tracked with its info panel open, but a `track=`
link has opened no info panel in either app since 578a54ca, and that stays: a scene that
needs a panel would need a field no link can carry.
Rejected: a shared file in the repo, bundled into the web app and generated for iOS. It
could not follow a plugin's preset, and a query means something only against its preset's
groups.

**One step contract, the same on both apps.** A **benchmark step** is a link plus what a
link cannot say: a satellite count, a clock rate, and skipping the label and model budgets
that `sceneSync` applies above 200 satellites. It is measured paced or unpaced. A step
runs as _apply → wait until loaded → settle → measure_. The default timings are the native
app's: loaded once everything active is drawn and has held for 2 s (90 s timeout), then
3 s to settle and 5 s to measure. A scene is a step with only a link. A **sweep** generates
steps from parameters, its `tag` and component set in the link and the rest as overrides.
Both apps run sweeps. A sweep step shows the first N satellites of the whole catalog by
name, sorted by UTF-16 code unit as JavaScript sorts, with its components past every
budget; it is cleared, built and measured unpaced. Its tables (steps, scaling, memory,
propagation, marginal, drift), its CSV, its JSON and its text table are the web's
`report.ts`, which the native app reproduces through the parity fixture. The native app
draws labels at any count to allow this: one glyph atlas, a quad per glyph. Its first
atlas held whole names and could not grow past 200. Every run ends by repeating its first
step, the drift check: the change in its CPU time, shown only past 1 ms, since a light
step's few percent are noise (0.3 ms read −16 % on the iPad). Frame rate was rejected as
its measure, because it moves with pacing and the GPU.

**The comparable core, defined once.**

The performance panel, the scene report and the sweep's rows report the same figures:
fps, CPU and GPU time, load, memory, the CPU and GPU p95, the share of frames over budget
and total CPU.

- **Frame rate**: drawn frames a second, from the gaps between them.
- **CPU time**: the main thread's work to draw a frame, from the start of the frame
  callback to submission, without the waits for a GPU buffer or a drawable. On the web
  this is Cesium's whole render-loop callback, `clock.tick()` and `scene.render()`
  together, because neither half works alone (see the benchmark README). Propagation worker
  replies are outside it in both apps. The web's split into `tickMs` and `cpuMs` stays as a
  sweep extra.
- **Total CPU**: every thread's CPU time over the recording, in % of one core. The
  main thread's time sets the frame rate; total CPU says what propagation and pass
  prediction cost besides it. iOS reads it from `getrusage`. The web adds the workers'
  reported time to its frame callbacks, which makes it a floor: it misses main-thread work
  outside a frame, such as worker replies and garbage collection, and the web shows it as
  "≥ n %". Sweeps fit and difference CPU time and show total CPU beside it.
- **Over budget**: the larger of the CPU's and the GPU's share of frames whose work
  outlasted the interval the chosen frame rate asks for, each side counted on its own, as
  the web times the GPU on only some frames. It reads the same paced or not. It replaced
  the frame-interval p50, p95 and slow share, which a paced step left empty or idle: a
  hitch outside a frame's work now shows only in fps. Idle, paced at under half the
  display's rate, only the CPU's side counts, here and in load: between frames the GPU
  clocks down and times each 1.7 to 2 times slower, so an idle globe read 28 ms of GPU
  time a frame that took 17 ms while dragged. The panel marks that time "(idle)".
  Dropping it would hide what an idle frame costs. Leaving it out whenever paced would
  also drop it while the globe is dragged, when a paced view draws every frame.
- **p95**: the CPU's and the GPU's 95th percentile of a frame's time, nearest rank.
- **GPU time**, **cpuBusy**, **gpuBusy** and **load**, `max(cpuBusy, gpuBusy)`, given only
  when both sides are known. Safari has no GPU timer query, so there the web knows only
  the CPU side. Chrome on ANGLE/Metal counts a saturated GPU's queue in each frame's time,
  so where those times outrun the frame interval they are capped at it, per half second
  or recording. Withholding them for the page's life once they overran blanked GPU time
  on the first drag until a reload. The report keeps `cpu_busy_pct` and drops
  `gpu_busy_pct`: where the GPU is known, load already says it. Its panel then
  shows load as "≥ n %" and the report leaves `load` empty. Estimating GPU time from frame
  interval minus CPU was rejected, because vsync quantises the frame interval.
- **Memory** is reported with its source (`phys_footprint`, `js_heap` or none; a sweep's
  `measureUserAgentSpecificMemory` footprint has columns of its own) and
  kept out of web-versus-native comparison: the two measure different things, and Safari
  measures none. The web labels its figure "heap".

The web's pure summary function, frame recording in and core metrics out, is the reference.
`scripts/parity/` generates a fixture from it, and the native app's tests must reproduce
it, so that rounding and percentile rank cannot drift apart. Percentiles are nearest rank,
`sorted[ceil(n·q) − 1]`, in both apps and in the web's sweep rows, which had used
`floor(n·q)`.

**One report, both apps.** The schema has `platform: web | ios`, the environment, the scene
definitions, the core metrics per step, and each app's own figures as `x_` metrics. Both apps send it as
the PostHog `benchmark` event, only when the user taps Send, and both export it as JSON.
Sweep reports stay in the console and in exports.

**One compact panel replaces both readouts.** Cesium's `debugShowFramesPerSecond` counter
goes, and the native `PerformanceOverlay` becomes the same panel. The panel shows fps, CPU and GPU time, load,
memory and satellites, averaged over at least 0.5 s up to a drawn frame. It never changes
render pacing: when frames are paced, its fps reads "paced" and load is the figure to read.
Paced means the app may skip a frame: not while tracking, in the sky view or in an unpaced
benchmark step, where every frame is drawn.
Before this, the web benchmark panel switched render on demand off, so the readout changed
what it measured. Tapping the panel expands it into a graph labelled "last 5 s", and it reads
the same figures paced or not. Each drawn frame is a bar of its CPU time, with its GPU time
marked, where it was drawn, against the frame budget: the interval the frame rate asks for,
never shorter than the display's. The report sends it as `app_frame_budget_ms`, beside
`app_frame_rate` as `30`, `60` or `max` in both apps. The graph keeps frames drawn in the
last 5 s of the clock, not of the last drawn frame, so a pause shows as a gap.
Below it are the CPU and GPU p95, the share of frames over budget and total CPU. Both
apps draw these as meters and per-side splits by share of the budget, at fixed widths,
chosen from seven web prototypes (branch `claude/perf-panel-prototype-127a32`). A graph of
frame intervals, with a slow share, was rejected: paced, the intervals are idle by design,
so the panel had to switch figures with the mode. A hitch outside a frame's work shows as a
gap. `fps` is in both url codecs: `true` shows the compact panel, `graph` the expanded one,
so a shared link about a stutter opens on the graph.

**`bench` starts a run from a link, in both apps, and the link does not spread.** `bench`
takes `true` (panel open) or `run` (open, and a run starts once the scene has loaded).
`benchscenes=<id>,<id>` limits the run to those scenes, without the drift repeat. As the
run starts, `run` is rewritten to `true`, so it never reaches a bookmark, Recent, a share or
the view restored after the run. A url-started run never sends its results: it prints them
(console or stdout, and `bench.report` on the web), and the user taps Send. This is the only
handle on Safari added to the Home Screen, which has no console and which safaridriver
cannot reach. On iOS, `SATVIS_BENCHMARK` becomes an alias for it and keeps its send mode,
because only a developer's `devicectl` can set it. `bench.scenes({ only })` gives drivers a
promise of the report.

## Consequences

- The benchmark panel has the same options and wording in both apps
  (`src/components/benchmark/`, `ios/satvis/Benchmark/`). A header holds the status line,
  worded by `benchmarkStatus.ts`, which the parity fixture holds the native app to. Below
  it are a progress bar and Scenes and Sweep tabs, locked while a run goes. Scenes are
  ticked to run a subset, and a measured row opens in place for the rest of its figures.
  The Sweep tab sets only counts, components and clock rates; the named sweeps, the
  timings, the web's absolute footprint and any population are the console's and the
  launch environment's. A step with ground station links adds the benchmark's station,
  which links need to draw. Then come the tables and the exports. The compact panel stays
  on screen during a run.
- Measurement costs something (timer queries, recording), so frames are measured only while
  the compact panel or the benchmark panel is shown.
- PostHog holds native-only events up to version 7 and two-platform events from version 8
  on. Compare across that boundary by scene id, and only for the native app.
