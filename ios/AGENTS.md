# AGENTS.md — iOS app

The native app: SwiftUI with no web view, reading the same worker as the web app.
Developed with Xcode 27, Swift 6 with MainActor default isolation in the app
target, iOS 26 and later. Xcode Cloud builds, numbers and publishes every release;
there is no fastlane. CI (`.github/workflows/ios.yml`, run only when `ios/`, the
web app's sources or the parity script change) runs on GitHub's `xcode-27` image,
a public preview, with Xcode 27.0 rather than the betas beside it, and lints with
that Xcode's `swift format`: a newer formatter's rules can fail `make lint` there.
Xcode 26's compiler rejects code Xcode 27's accepts, so CI moves with the Xcode
the app is developed on. Why it is built this way, and the milestones it is built in, are in
`docs/adr/0009-native-ios-app.md`. The WebView app it replaces is the tag
`ios-webview-final`.

## Layout

- `SatvisKit/` is a local Swift package holding everything that is not a view.
  `SGP4` is Vallado's reference C++, vendored unmodified (`vallado/VENDOR.md`)
  behind a C bridge, so no Swift module needs C++ interoperability. `SatvisCore`
  holds element sets, the group index, propagation, sampled trajectories, the Sun,
  ground stations and pass prediction, and the arithmetic the web app does on
  them. `SatvisData` holds the worker client and its disk cache. `SatvisRender`
  is the Metal globe. The app target holds the
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
  That sum is in float, metres out at 7,000 km, so the tracked satellite is
  placed instead by its position from the eye, which the CPU works out in double
  precision for the camera anyway (`FrameUniforms.focus`): close up, the point
  and the cone shook against the camera.
  An orbit is half a period either side of the satellite, through where it is
  now, as CesiumJS's path is: its samples are 50 s apart for a low orbit, and
  their chord passes 2 km under the satellite. It is closed into a loop as
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
  observer is where the device is, kept as the one saved station named
  "Geolocation" and moved there each time, as on the web (ADR 0003): the Sky
  panel's Look up stands there, as does a link to the sky view that names no
  station. It is listed first, by Look up and by Locations' My location alike, as
  on the web, where a link's stations are its list and its sky view stands on
  the first; the app also writes the observer first into the links it makes. A link that names one stands on
  its first, and a station's panel on that station. Its own pin is hidden
  underfoot. What cannot be seen
  (ADR 0010) is dimmed or hidden by the point and label shaders, from the frame's
  sun and how dark the observer's sky is (`SkyJudgement`): per satellite on the
  CPU it would cost what the lock costs, every frame. A dimmed 3D model is drawn
  blended whole; the card's verdict is the same `Visibility`, in double precision.
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
  over Bookmarks, Satellites, Components, Map, Locations, Globe, Sky and Graphics, with their
  Lucide icons, names and order, and their hover hints, trimmed to what the
  app has, as VoiceOver hints, one glass panel
  whose rows each hold an icon and its name, folded on a phone and open on an
  iPad, as the web's is on a desktop. Components, Map, Globe, Sky
  and Graphics open the web's panels beside it (`ToolPanels.swift`): a title and a
  close button over a rule level with the column's, sections under small titles,
  switches, a segmented control where the choices are short, ticked rows where
  they are long; a setting that needs the sky view is disabled on the globe,
  not hidden. On a phone the column folds to its icons beside a panel, which
  covers the top-right buttons, as the web's does below 640 px. Not system
  menus: iOS 26 grows one out of its control, in the column's place, and it holds
  ticked lists alone. Bookmarks, Satellites and Locations are sheets: long lists.
  A tap on the globe closes the panel and on a phone folds the column, as on
  the web, and a miss that did so keeps the selection.
  What the app does not draw is left out: Map's overlays, surface and star map;
  Globe's 2D and Columbus projections; Sky's keyboard note; Graphics' scene
  effects and MSAA.
- Bookmarks are the web app's (ADR 0011, `BookmarksView.swift`): the same records,
  a preset's path and the parameters the web app's stores own, so the code that
  describes and names them (`Bookmarks` in SatvisCore) is held to its
  `bookmarks.ts` by the parity fixtures, and the demos and the owned parameters
  come from `web-tables.json`. A bookmark opens through `Session.open`, carrying the
  link's other parameters, and goes live without a `time`. Saved ones and opened
  links are kept in Application Support (`BookmarkStorage`), in backups, and synced
  nowhere; a deleted one's picture stays while its own Undo lasts. A card's
  actions are a long press, and a "…" on the card shows they are there. An opened link is one the system hands over, the About page's, or
  `SATVIS_LINK`: not the view a last run left, which is a reload. Pictures are the
  renderer's next frame (`GlobeRenderer.snapshot`), read from a drawable asked
  for readable for that frame alone, 480 pixels across where the web app's are
  320, soft on a card at 3x; an opened link's once everything active is drawn, as
  the web app waits for its scene. The demos' are the site's `showcase/`
  pictures, fetched as the star map is (`GroupRepository.image`): revalidated each
  launch, kept, and shown offline once fetched. A launch on the test catalog
  keeps its bookmarks apart, so every UI test starts with none.
- The Globe panel's camera mode is the web app's `camera` (`CameraFrame`, kept
  in links): Fixed, or Inertial, where the free camera is turned back each frame
  by as far as the Earth has turned (`OrbitCamera.holdInertial`, the Greenwich
  hour angle the satellites are rotated by), so the Earth turns under it and a
  scrubbed clock spins it. Tracking keeps the satellite's frame and the sky view
  the observer's; the free camera waits meanwhile, and the sky view keeps the
  choice for the way back, as the web suspends it there.
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
- The Graphics menu's "Frame rate" caps the globe at 30, 60 or 120 frames a second
  (`preferredFramesPerSecond`), offering only what the screen shows: 120 on a
  ProMotion screen, which an iPhone gives an app only with
  `CADisableMinimumFrameDuration` in `Info.plist`. The simulator reports 60
  whatever it models. The web app has no such parameter, so the rate is kept in
  `UserDefaults`, not links; a benchmark records it as `app_frame_rate`. The
  globe is drawn every frame: unlike CesiumJS's `requestRenderMode`, nothing
  skips a frame when nothing has changed.
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
  from a release build on satvis.space with PostHog's project key and host, which
  are not committed: `Config/Base.xcconfig` includes them from the gitignored
  `Config/Analytics.xcconfig` (copy `Analytics.example.xcconfig`), and Xcode
  Cloud's `ci_scripts/ci_post_clone.sh` writes that file from the workflow's
  `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST`. So development, the UI tests, a
  local worker and a checkout without the file count nothing; check a change with a Release build in the simulator,
  whose events carry `$is_emulator`. "Share usage data", beside the privacy policy in the Attribution sheet, opts
  out; the web app has no switch, and so no menu entry to keep it in.
  The app keeps that choice (`shareUsageData` in `UserDefaults`), not PostHog:
  opted out, PostHog is not set up at all, so nothing is sent, not even its
  remote config. PostHog's defaults that send more than the privacy policy says
  are off by name: feature flags, default person properties, rage clicks.
- `Info.plist` is generated from `INFOPLIST_KEY_*` build settings. The file
  `satvis/Info.plist` holds only the keys that have no build setting:
  `UILaunchScreen`, `NSAppTransportSecurity` to allow a local worker, the
  background refresh's `UIBackgroundModes` and `BGTaskSchedulerPermittedIdentifiers`,
  and PostHog's key and host, passed through from the xcconfig.
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

`make` in `ios/` runs them: `build`, `test`, `test-kit`, `run`, `logs`, `format`,
`lint`, `screenshots`, `upload-screenshots`, `clean`. `DEVICE="iPad Pro 13-inch (M5)"` picks
the simulator by name, on `RUNTIME="iOS 27"` or the newest runtime that has it
(default `iPhone 17`); `UDID=…` picks one exactly.
`make run` opens no simulator window; follow the app with `make logs`.

- **`test-kit`** runs the package tests on macOS, with no simulator. **`test`** runs
  them, then the UI tests, which need no network: they point the app at a worker
  that is not there and set `SATVIS_TEST_CATALOG`, which starts a Debug build
  from a fixed catalog (`TestCatalog.swift`, `UITestCatalog.json`, which the
  Release configuration's `EXCLUDED_SOURCE_FILE_NAMES` leaves out), open the
  satellite browser, find a satellite there, and open its panel from there.
- **`run API=…`** installs and launches against another worker, e.g. a local one
  at `http://localhost:8080` (`pnpm dev:worker` at the repository root).
- **`screenshots`** erases one simulator per App Store size (the required 6.3"
  iPhone 18 Pro, creating it if missing, the 6.9" Pro Max and the 13" iPad) and
  writes `screenshots/raw/`, then `scripts/caption.swift` puts each one's caption,
  kept in `scripts/screenshots.sh`, above it in `screenshots/`, at the same pixel
  size and without the alpha channel App Store Connect rejects. It takes the
  Bookmarks sheet's demos, opened from their cards, in the order globe, sky, ISS,
  since the first three are what a search result shows, each with the clock
  stopped at the minute its test names (`SATVIS_TIME`, which opening a bookmark
  leaves stopped), from the site `BASE_URL` names (satvis.space by default). Each shot is taken on its own, under a status
  bar reading its minute and date, as the clock deck does. `SHOTS=2Sky` retakes
  only the shots it names, for one whose tiles had not loaded.
- **`upload-screenshots`** replaces the screenshots of the version being prepared
  with `screenshots/*.png` through the App Store Connect API
  (`scripts/upload-screenshots.swift`), in the app's primary language, each file
  to the display type its width names. It needs an API key with the App Manager
  role: `ASC_KEY_ID`, `ASC_ISSUER_ID`, and the `.p8`, at `ASC_KEY_PATH` or
  base64-encoded in the login keychain (the script's header has the command).
  `DRY_RUN=1` says what it would replace. App Store Connect then checks each file,
  which took from seconds to over 20 minutes a file on 2026-10-08; the script
  waits 10 minutes and names the files it is still on, which stay uploaded.

## The worker

- `SATVIS_API` in the launch environment replaces satvis.space: `make run API=…`,
  or a scheme environment variable in Xcode. `SATVIS_TIME` (ISO 8601, UTC) pins
  the clock at that instant and pauses it, for screenshots and for checking the
  lighting. `SATVIS_LINK` opens on a link, a whole url or a path with its query
  (`/ot?tags=OT`), ahead of the view a last run left; the UI tests open on `/`.
- `GroupRepository` revalidates every payload with its ETag, keeps it in
  Application Support, and falls back to the kept copy when the worker cannot be
  asked. The app ships no catalog: a bundled one is weeks out of date by the time
  most people install, and the first answer replaces it anyway. A first launch
  offline shows a note and asks again every 10 s. A 200 that is not JSON counts as no answer: a host
  without the worker serves its index.html for any path. The app never waits on
  the worker for what a copy can show: the index and each group come from the
  kept copy first (`keptIndex`, `keptRecords`), the worker's
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
grid, the sun and the sky view's visibility verdict, the info panel's details, and passes over three ground stations in both
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
