# AGENTS.md — iOS app

The native app: SwiftUI with no web view, reading the same worker as the web app.
Developed with Xcode 27, Swift 6 with MainActor default isolation in the app
target, iOS 26 and later. Xcode Cloud builds, numbers and publishes every release;
there is no fastlane. CI (`.github/workflows/ios.yml`, run only when `ios/`, the
web app's sources or the parity script change) builds with the newest Xcode its
macOS runner has, Xcode 26.6 at the time of writing, and lints with that Xcode's
`swift format`: a newer formatter's rules can fail `make lint` there. Why it is built this way, and the milestones it is built in, are in
`docs/adr/0009-native-ios-app.md`. The WebView app it replaces is the tag
`ios-webview-final`.

## Layout

- `SatvisKit/` is a local Swift package holding everything that is not a view.
  `SGP4` is Vallado's reference C++, vendored unmodified (`vallado/VENDOR.md`)
  behind a C bridge, so no Swift module needs C++ interoperability. `SatvisCore`
  holds element sets, the group index, propagation, sampled trajectories, the Sun,
  ground stations and pass prediction, and the arithmetic the web app does on
  them. `SatvisData` holds the worker client, its disk cache, and the snapshot
  shipped in the app. `SatvisRender` is the Metal globe. The app target holds the
  views, their models and the session that ties them together.
- `SatvisRender`'s shaders are `Shaders/*.msl`, compiled at run time by
  `ShaderLibrary` off the main thread, so neither the build nor CI needs Xcode's
  separately downloaded Metal toolchain. `RendererTests` compiles them on macOS,
  which is where a shader error shows. The atmosphere, lighting and tone mapping are
  CesiumJS's, ported, with the web app's defaults: a ported file keeps Cesium's
  Apache 2.0 notice and says what changed, and `LICENSE.CesiumJS.md` stays beside
  them, verbatim.
- The globe's surface is a quadtree of geographic tiles (`Surface`), refined by
  screen-space error as CesiumJS's is, but in device pixels where CesiumJS counts
  CSS pixels, each with a 256-texel texture baked from the base map
  (`Imagery.swift`): Natural Earth's level 2 first, which the app target's "Copy
  Natural Earth" phase copies from the web app's `data/imagery` rather than
  keeping a second copy, then the base map's tiles
  as they load, the nearest loaded ancestor standing in. A Mercator tile's
  texture coordinates are worked out in double precision on the CPU, a strip of
  rows at a time: a float cannot place a pixel at level 19. Tiles come through
  `TileFetcher`, a URLSession with its own 500 MB cache in Caches, served from
  the cache whatever their age, which leaves a host alone for as long as a 429
  asks. Natural Earth's levels 3 to 5 are kept for good instead (`KeptTiles`, in
  Application Support), since the whole pyramid is 17 MB: a place seen once
  shows offline, whatever the system purges. The base map and the terrain are the Map menu's, kept between launches.
- Terrain (`Terrain.swift`) is Re:Earth's quantized mesh, decoded and kept per
  terrain tile; a surface tile's grid is laid over the terrain tile log₂(screen
  scale) levels coarser, the level the web app would ask for, so the app asks
  Re:Earth no more than the web app does. ADR 0009 has why. The texture budget
  is soft: a low, oblique view can use more tiles than it, and evicting tiles in
  use only starts the refinement over.
- About, in the top-right column, is the web app's About dialog (`AboutView.swift`):
  what Satvis is, the about page's three demos (opened in the app, by their links),
  what it does and where its data comes from, written for the app. Keep the demos'
  links in step with `about.html`'s.
- The attribution is the web app's credit display: an "Attribution" link above
  the clock deck opens what the map is drawn from now (`Credit.map`), the
  element sets' source, and the site's privacy policy. The terrain's sources are
  copied from Re:Earth's `layer.json`, which CesiumJS reads at run time; check
  them against it when the terrain changes. The licences the app owes are M6's.
- The star map is the web app's `DeepStar1K`, fetched from the site
  (`data/starmap/`) and kept like the GP data, not shipped: it is generated with
  Docker by `pnpm update-starmap`, and committing it here would be a second copy.
  The sky is black until the first fetch.
- The renderer works in the Earth-fixed frame in metres, relative to the eye,
  with reversed-Z depth and no far plane. Satellites are placed by high/low float
  pairs, in vertex functions compiled with safe math, which fast math could
  regroup; the globe's tiles are drawn relative to their centres, offset from the
  eye in double precision on the CPU. Everything else, every fragment function
  included, is compiled with fast math (`ShaderLibrary`): safe math made the
  full-screen passes and the atmosphere's per-vertex scattering twice as slow.
  The sky atmosphere is CesiumJS's shell, coloured per vertex; from more than
  10 % outside it only the ring it shows round the globe is drawn
  (`skyRingVertex`), 512 pieces around, as the whole shell's facets showed as
  bumps along the limb and a shell fine enough to hide them cost 3 ms a frame.
  Satellites are points the vertex shader interpolates from each one's sampled
  trajectory, with the web app's quintic; the CPU only finds each stencil.
  An orbit is half a period either side of the satellite, closed into a loop as
  the web app's `positionsForNextOrbit` closes it: the drift one period brings
  (J2: 31 km for the ISS) is ramped out over the quarter furthest behind it.
  Orbits behind the Earth are drawn with no width, so the GPU drops their
  triangles before sorting them into tiles: with every active satellite's orbit
  that took an iPad mini's GPU from 57 to 33 ms a frame, where cheaper pixels
  saved 4.
  The ground tracks are drawn once a second into the ground overlay, a cube map
  around the Earth's centre that the globe samples by direction, so they will
  follow terrain; `RendererTests` holds its faces to Metal's own cube lookup. The
  sensor cones are drawn per frame from the same interpolation, cut where they
  meet the ground. Both are for low orbits only, as on the web.
- 3D models are the web app's files, fetched from the site's `/data/models/` by
  the `modelFile` a record carries and cached as the tiles are. `ModelAsset`
  reads only what `data/models` uses (triangles, Draco, base colours, PNG, JPEG
  and WebP textures); Draco is DracoSwift's prebuilt 1.5.7 behind `DracoBridge`.
  Sizes, the point and label around a model and the close-up tracking follow
  `SatelliteComponentCollection.ts`; the lighting is a simple sun, not Cesium's
  PBR. `ios/scripts/make-model-fixture.mjs` writes the test's cube.
- `Session`, owned by `SatvisApp`, is one open globe: the models (`ViewerClock`,
  `CatalogModel`, `PassModel`, `SatelliteLayer`, `StarMap`, and `PassAlerts`, which
  the background refresh needs too), what is selected and followed, what a tap
  does, and the work that keeps them in step. It watches the models with
  `Observations` rather than taking callbacks, so anything can watch them too.
  The views read it and call it and hold nothing else but what is on screen, so
  that what opens the app with a state of its own (a link, a restored scene) sets
  it in one place. Passes are predicted on demand, once a second, by `PassStore`:
  for the selected satellite, and for every active one while a station is
  selected or the ground station links are drawn. Each prediction holds for a day
  either side of when it was made, as on the web.
- A link is the view, as on the web (ADR 0001): `LinkCodec` reads one onto its
  preset's defaults and `Session.open` applies it, replacing what is shown;
  `Session.link` writes the view back. Parameters the app does not honour (`stars`,
  `surface`…) are kept as they came and written into every link it makes.
  The view is kept as a link when the app goes to the background and reopened
  from it, without its time, so the app reopens live. Past a component's budget
  (labels at 200 active satellites, ground station links at 500, 3D models at 200
  that have one) it switches off
  once, on the crossing, unless the link being opened names it, and a link then
  names it whenever it is on, as on the web (ADR 0001). Labels past 200 are still
  not drawn, even switched on: their atlas would outgrow a texture. A link's ground stations
  visit: they are shown and predicted for, but saved only on the user's word, and
  have no alerts until then. A shared link carries the visiting stations and the
  selected one, never the rest of the saved ones, which are often where the user
  lives. Share makes the link when tapped, so a pinned clock gives its minute
  then. satvis.space links open the app as universal links: the site's
  `public/.well-known/apple-app-site-association` claims `/ot` and `/` with a
  query, and `satvis.entitlements` the `applinks:satvis.space` domain, which
  needs the Associated Domains capability on the App ID. The simulator builds
  here are unsigned and carry no entitlements, so a universal link needs a signed
  build on a device; `SATVIS_LINK` goes through the same `Session.open`.
- The sky view (ADR 0003) is the same renderer from the ground: `SkyCamera`
  stands 2 m over the terrain at the observer, its attitude a quaternion in the
  observer's east-north-up frame, so the zenith is an aim like any other. It
  stands on Re:Earth's terrain whatever the Map menu says. `SkyFlight` is the
  web's three-leg flight in and out; the instruments (`SkyHUD`) and the gestures
  wait for it to land, and reduced motion cuts. The crosshair, the tapes, the
  trace and the card read the renderer's last frame (`SkyTargets.swift`), and
  the lock is the tap: from the ground a tap opens what the crosshair holds.
  Compass aiming (`SkyCompass`) is CoreMotion's attitude against true north, or
  magnetic north without a location, so it needs no calibration step; it can
  only be tried on a device, the simulator having no motion sensor. The
  observer is a link's first station, and the station whose panel opened it,
  and its own pin is hidden underfoot.
- The globe's gestures are SwiftUI's, not UIKit recognizers on the MTKView, so the
  controls laid over it take the touches that land on them. They go to the
  renderer, which steers whichever camera its `CameraMode` says is in use: the free
  one over the globe, or one following a satellite or a station.
- Ground stations are kept in `UserDefaults` on the device and synced nowhere:
  iCloud key-value sync was dropped, as it brought little and cost a section of
  the privacy policy. A station has an id, and everything that refers to one
  holds the id, not its place in the list or its name: the open panel, the
  renderer's marker (`station|<id>`), each pass, and an alert, which is dropped
  with its station.
- Every element set reaches SGP4 as OMM keywords (`MeanElements`). The worker's
  pseudo element sets still arrive as TLE lines; they are read into the same
  keywords at parse time, and Vallado's `twoline2rv` is never called.
- `satvis/` and `satvisUITests/` are folder-synchronized: a file added on disk joins
  its target, with no `project.pbxproj` edit. A new package product does need one.
- `satvis/PrivacyInfo.xcprivacy` is the privacy manifest App Store Connect
  requires: no tracking; product interaction collected for analytics, and a
  coarse location (the sky view's station, to the whole degree, in a page view's
  link), and performance data (the benchmark's results, sent by hand), all
  linked to no one; `UserDefaults` read by the app alone, and the
  system uptime the renderer's flights are timed by. The PostHog package brings
  its own manifest for the APIs it uses. Add to the app's with every
  required-reason API and every data type collected, and keep the App Store
  privacy label in step with it.
- The menu column is the web app's (`Satvis.vue`'s `menuItems`): a Menu toggle
  over Satellites, Components, Ground station, Map, View and Graphics, with their
  Lucide icons, names and order, and their hover hints, trimmed to what the
  app has, as VoiceOver hints, one glass panel
  whose rows each hold an icon and its name, folded on a phone and open on an
  iPad, as the web's is on a desktop. Components, Map, View
  and Graphics open the web's panels beside it (`ToolPanels.swift`): a title and a
  close button over a rule level with the column's, sections under small titles,
  switches, a segmented control where the choices are short, ticked rows where
  they are long. On a phone the column folds to its icons beside a panel, which
  covers the top-right buttons, as the web's does below 640 px. Not system
  menus: iOS 26 grows one out of its control, in the column's place, and it holds
  ticked lists alone. Satellites and Ground station are sheets: long lists.
  A tap on the globe closes the panel and on a phone folds the column, as on
  the web, and a miss that did so keeps the selection.
  What the app does not draw is left out: Map's overlays, surface and star map;
  View's 2D, Columbus and camera modes; Graphics' scene effects and MSAA.
- The Graphics menu's "FPS" is the web app's FPS switch, kept in links as
  `fps=true` as the web keeps it (`PerformanceOverlay.swift`, `FrameStats`):
  frames per second, the renderer's CPU and the GPU's milliseconds a frame,
  satellites drawn and the memory footprint iOS counts. Nothing is timed while it
  is off. The instruments over the sky view are SwiftUI's, outside the
  renderer's CPU figure; a slow frame shows in the frame rate. Read it on a
  device: the simulator runs on the Mac's CPU and GPU. For where the time goes,
  profile a Release build with Instruments' Time Profiler (`xcrun xctrace record
  --template "Time Profiler" --attach <pid>`). A Release build sends usage to
  PostHog only for the site `https://satvis.space/` exactly, so pointing
  `SATVIS_API` at `https://satvis.space` measures the real data and counts
  nothing.
- The Graphics menu's "Pixel ratio" is the web app's (`pixelratio`, kept in links):
  the globe drawn at 1 or 1.5 pixels a point instead of the screen's own, which
  the system scales up (`ScaledMTKView` in `GlobeView.swift`). The renderer sizes
  everything placed on the screen in points times the drawable's pixels a point,
  labels included, so only the sharpness changes; the map refines a level less, as
  its error is measured in the drawable's pixels. On an iPad mini, before the
  shaders took fast math, the default view took 10.5 ms of GPU a frame at native,
  6.7 at 1.5 and 2.8 at 1. A benchmark runs
  at the ratio it began at and records it.
- The Graphics menu's "Benchmark" is the web app's `bench=true`, kept in links
  the same way (`Benchmark.swift`, `BenchmarkPanel.swift`): eight scenes opened
  by their links in turn, each waited for until everything active is drawn,
  settled 3 s and recorded 5 s frame by frame (`FrameRecording`), then the first
  again for drift, and the view put back. A run counts no page views. "Send
  results" sends one `benchmark` event, only where usage is shared, its
  properties flat for PostHog's insights: `benchmark_` and `app_` for the run,
  `device_` for the device, system and screen, and `scene_<scene>_<metric>` per
  scene (`_repeat` for the drift check). Bump `Benchmark.version` when the scenes
  or the metrics change. The panel drops its glass while measuring: blurring the
  globe cost the GPU 2 ms a frame on an iPad mini. `SATVIS_BENCHMARK` in the
  launch environment runs it at once, sends the results itself and prints them
  as JSON, for a device driven from the Mac; `SATVIS_BENCHMARK=print` only
  prints them, and `SATVIS_BENCHMARK_SCENES` (scene ids by commas) runs only
  those:
  `xcrun devicectl device process launch --console --environment-variables
  '{"SATVIS_BENCHMARK":"1"}' org.frcy.app.satvis`.
- Analytics (`Analytics.swift`) is posthog-ios, set up from the app delegate as
  its guide has it, reporting to the web app's project (ADR 0009): a `$pageview`
  of the view's link whenever the view changes, the clock aside, its ground
  stations cut to the whole degree as the web's `posthogPrivacy.ts` does
  (`sanitizedForAnalytics`, held to it by the parity fixtures). It reports only
  from a release build on satvis.space, so development, the UI tests and a local
  worker count nothing; check a change with a Release build in the simulator,
  whose events carry `$is_emulator`. "Share usage data", beside the privacy policy in the Attribution sheet, opts
  out; the web app has no switch, and so no menu entry to keep it in.
  The app keeps that choice (`shareUsageData` in `UserDefaults`), not PostHog:
  opted out, PostHog is not set up at all, so nothing is sent, not even its
  remote config. PostHog's defaults that send more than the privacy policy says
  are off by name: feature flags, default person properties, rage clicks.
- `Info.plist` is generated from `INFOPLIST_KEY_*` build settings. The file
  `satvis/Info.plist` holds only the keys that have no build setting:
  `UILaunchScreen`, `NSAppTransportSecurity` to allow a local worker, and the
  background refresh's `UIBackgroundModes` and `BGTaskSchedulerPermittedIdentifiers`.
- Pass notifications (`PassAlerts`) are kept rather than sent once, as the web app
  sends them: the subjects are saved, and every launch, return to the foreground
  and background refresh predicts them again from the newest element sets and
  replaces the pending ones with the earliest 64, iOS's limit, two a pass
  (`PassNotificationPlan`). Over a busy station those can run out within hours, so
  the app says until when they reach, and asks to be woken an hour before, within
  four hours. A background refresh asks for the next one before it starts work,
  so one that runs out of time does not end the chain, and leaves the pending
  notifications as they were. It is only asked for while there are alerts. To run
  one, pause the app in the debugger and
  `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"org.frcy.app.satvis.passes"]`.
- The app icon (`AppIcon.icon`) and the launch image are cut from `public/logo.svg`:
  counting its `<path>`s from 0, 0 is the #0b222d background, 1–3 sky, 4–6 hills,
  7–49 shuttle and 50–51 exhaust. Cut them again when the logo changes.

## Tasks

`make` in `ios/` runs them: `build`, `test`, `test-kit`, `run`, `logs`, `snapshot`,
`format`, `lint`, `screenshots`, `clean`. `DEVICE="iPad Pro 13-inch (M5)"` picks
the simulator by name, on `RUNTIME="iOS 27"` or the newest runtime that has it
(default `iPhone 17`); `UDID=…` picks one exactly.
`make run` opens no simulator window; follow the app with `make logs`.

- **`test-kit`** runs the package tests on macOS, with no simulator. **`test`** runs
  them, then the UI tests, which need no network: they point the app at a worker
  that is not there, open the satellite browser, find a satellite in the kept copy
  or the snapshot, and open its panel from there.
- **`run API=…`** installs and launches against another worker, e.g. a local one
  at `http://localhost:8080` (`pnpm dev:worker` at the repository root).
- **`snapshot`** refreshes the snapshot shipped in the app from satvis.space (or
  `API=…`): the group index and the groups the default preset enables. Run it
  before a release.
- **`screenshots`** erases one simulator per App Store size and writes
  `screenshots/`. Upload them to App Store Connect by hand. It takes the about
  page's demo views by their links (`about.html`), each paused at its link's
  minute, from the site `BASE_URL` names (satvis.space by default). Labels are
  not drawn past 200 active satellites, so the sky view's has none where the
  web's does.

## The worker

- `SATVIS_API` in the launch environment replaces satvis.space: `make run API=…`,
  or a scheme environment variable in Xcode. `SATVIS_TIME` (ISO 8601, UTC) pins
  the clock at that instant and pauses it, for screenshots and for checking the
  lighting. `SATVIS_LINK` opens on a link, a whole url or a path with its query
  (`/ot?tags=OT`), ahead of the view a last run left; the UI tests open on `/`.
- `GroupRepository` revalidates every payload with its ETag, keeps it in
  Application Support, and falls back to the kept copy, then the snapshot, when
  the worker cannot be asked. A 200 that is not JSON counts as no answer: a host
  without the worker serves its index.html for any path. The app never waits on
  the worker for what a copy can show: the index and each group come from the
  kept copy or the snapshot first (`keptIndex`, `keptRecords`), the worker's
  answer replaces them when it lands, and a return to the foreground asks again
  for every group loaded. Requests time out after 15 s.
- Work that grows with the number of satellites stays off the main thread, or is
  done only when its input changes: the GPU buffers are packed by
  `GlobeRenderer.prepare`, `CatalogModel.activeEntries` is kept rather than
  worked out on every read, `PassModel` publishes only what was predicted again,
  and the station links are rebuilt only when the passes change. Past 500 active
  satellites the links are not drawn, as the web app switches them off.
- Tags and presets come from the group index, not from the app.

## Parity with the web app

`SatvisKit/Tests/SatvisCoreTests/Fixtures/parity.json` is what the web app's own
code answers for the element sets in `parity-input.json`: positions, the sampling
grid, the info panel's details, and passes over three ground stations in both
overpass modes, with the rows, headline and timeline strip the panel makes of
them. It also holds the URL codec's answers (`urlCodec.ts`, with vue-router's
query parser and serializer): each kind of parameter on awkward input, and whole
links read onto a preset and written back, over the parameters and vocabularies
the app honours (`LinkCodec`). `SatvisCore/Shared/web-tables.json` is the web
app's SATCAT labels and external links, read as they are. Regenerate both with
`pnpm update-parity-fixtures` at the repository root; never edit them by hand. CI
fails while it is stale. SGP4 states agree with satellite.js to under a
micrometre and are held to a centimetre. That depends on setting the satrec up as
satellite.js does: the epoch as a year and fractional day, an OMM `EPOCH`
truncated to the millisecond as a JavaScript Date keeps it, and the time since
epoch from satellite.js's own `jday`. The rotation into the pseudo-fixed frame is
Cesium's GMST polynomial, not satellite.js's `gstime`, and the port has to stay
operation for operation (`GreenwichHourAngle.swift`). Pass prediction
(`PassFinder`) is `Orbit.ts` step for step, down to JavaScript's Date: each instant
is truncated to a whole millisecond before it is propagated. Both overpass modes
search for their edges and peaks to 10 ms, and agree to that.

## Gotchas

- **`make test` never exits after a failed test**, nor does the `xcodebuild` under
  it. Watch the output for `** TEST FAILED **` and stop it. `Test Suite 'All tests'`
  also appears once before that, from the package tests that run first.
- **Keep the vendored SGP4 byte for byte.** It is excluded from the pre-commit
  hooks and `.editorconfig`, which would otherwise strip its trailing spaces.
- **An edit made while `xcodebuild` is building can be left out of it**, and the UI
  test then runs the previous build: its failures name lines of the old file, and
  the log lacks steps the source has. `touch` the file and run again.
- **A lazy `List` has no rows off screen**, so a UI test has to scroll a row into
  view before it can find it. `LabeledContent` reads as one element labelled
  `"<label>, <value>"`, not as two texts.
- **A simulator keeps its cached launch screen across reinstalls.** Judge
  launch-screen changes on a simulator that never had the app, or after
  `simctl erase`; the screen shows for ~1.5 s, so record it with
  `simctl io <udid> recordVideo`.
- **An open Xcode rewrites `project.pbxproj`** — it re-sorts entries you added by
  hand. Close the project before editing the file, or expect the churn.
