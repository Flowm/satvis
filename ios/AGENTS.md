# AGENTS.md — iOS app

The native app: SwiftUI with no web view, reading the same worker as the web app.
Xcode 27, Swift 6 with MainActor default isolation in the app target, iOS 26 and
later. Xcode Cloud builds, numbers and publishes every release; there is no
fastlane. Why it is built this way, and the milestones it is built in, are in
`docs/adr/0007-native-ios-app.md`. The WebView app it replaces is the tag
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
  (`Imagery.swift`): the shipped Natural Earth first, then the base map's tiles
  as they load, the nearest loaded ancestor standing in. A Mercator tile's
  texture coordinates are worked out in double precision on the CPU, a strip of
  rows at a time: a float cannot place a pixel at level 19. Tiles come through
  `TileFetcher`, a URLSession with its own 500 MB cache in Caches, served from
  the cache whatever their age, which leaves a host alone for as long as a 429
  asks. The base map and the terrain are the Map menu's, kept between launches.
- Terrain (`Terrain.swift`) is Re:Earth's quantized mesh, decoded and kept per
  terrain tile; a surface tile's grid is laid over the terrain tile log₂(screen
  scale) levels coarser, the level the web app would ask for, so the app asks
  Re:Earth no more than the web app does. ADR 0007 has why. The texture budget
  is soft: a low, oblique view can use more tiles than it, and evicting tiles in
  use only starts the refinement over.
- The attribution is the web app's credit display: an "Attribution" link above
  the clock deck opens what the map is drawn from now (`Credit.map`), the
  element sets' source, and the site's privacy policy. The terrain's sources are
  copied from Re:Earth's `layer.json`, which CesiumJS reads at run time; check
  them against it when the terrain changes. The licences the app owes are M6's.
- The star map is the web app's `DeepStar1K`, fetched from the site
  (`data/starmap/`) and kept like the GP data, not shipped: it is generated with
  Docker by `pnpm update-starmap`, and committing it here would be a second copy.
  The sky is black until the first fetch.
- The renderer works in the Earth-fixed frame in metres, relative to the eye
  (high/low float pairs, safe math), with reversed-Z depth and no far plane.
  Satellites are points the vertex shader interpolates from each one's sampled
  trajectory, with the web app's quintic; the CPU only finds each stencil.
  The ground tracks are drawn once a second into the ground overlay, a cube map
  around the Earth's centre that the globe samples by direction, so they will
  follow terrain; `RendererTests` holds its faces to Metal's own cube lookup. The
  sensor cones are drawn per frame from the same interpolation, cut where they
  meet the ground. Both are for low orbits only, as on the web.
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
- The globe's gestures are SwiftUI's, not UIKit recognizers on the MTKView, so the
  controls laid over it take the touches that land on them. They go to the
  renderer, which steers whichever camera its `CameraMode` says is in use: the free
  one over the globe, or one following a satellite or a station.
- Ground stations are kept in `UserDefaults` and mirrored to iCloud key-value
  storage (`satvis.entitlements`), so they follow the user to their other
  devices. That needs the iCloud capability on the App ID. A station has an id
  that syncs with it, and everything that refers to one holds the id, not its
  place in the list or its name: the open panel, the renderer's marker
  (`station|<id>`), each pass, and an alert, which is dropped with its station.
- Every element set reaches SGP4 as OMM keywords (`MeanElements`). The worker's
  pseudo element sets still arrive as TLE lines; they are read into the same
  keywords at parse time, and Vallado's `twoline2rv` is never called.
- `satvis/` and `satvisUITests/` are folder-synchronized: a file added on disk joins
  its target, with no `project.pbxproj` edit. A new package product does need one.
- `satvis/PrivacyInfo.xcprivacy` is the privacy manifest App Store Connect
  requires: no tracking, no data collected, and `UserDefaults` read by the app
  alone. Add to it with every required-reason API and every data type collected;
  PostHog (M5) brings both.
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
  `screenshots/`. Upload them to App Store Connect by hand. For now it takes only
  the UI test's view of the browser: the about page's three demo views were the
  WebView app's tests, opened by url, and come back natively with the links (M5).
  `BASE_URL` does nothing until then.

## The worker

- `SATVIS_API` in the launch environment replaces satvis.space: `make run API=…`,
  or a scheme environment variable in Xcode. `SATVIS_TIME` (ISO 8601, UTC) pins
  the clock at that instant and pauses it, for screenshots and for checking the
  lighting.
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
them. `SatvisCore/Shared/web-tables.json` is the web
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
is truncated to a whole millisecond before it is propagated, and `setMinutes`
truncates the minutes it skips. Elevation passes then agree exactly; swath passes
to the 10 ms their edges are bisected to.

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
