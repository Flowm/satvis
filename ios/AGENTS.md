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
- `satvis/` and `satvisUITests/` are folder-synchronized: a file added on disk joins
  its target, with no `project.pbxproj` edit. A new package product does need one.

**Before adding, moving or looking for a file, or changing how any part of the
app works**, read `docs/architecture.md`, the app part by part: the renderer, the
map, terrain and models, the session and links, the sky view, the panels and
bookmarks, frame pacing and the benchmark, analytics and the privacy manifest,
pass alerts and the icon.

## Tasks

`make` in `ios/` runs them: `build`, `test`, `test-kit`, `run`, `logs`, `format`,
`lint`, `screenshots`, `screenshots-upload`, `screenshots-download`,
`metadata-download`, `metadata-upload`, `clean`;
`make` alone (`make help`) lists them and the variables they take.
`DEVICE="iPad Pro 13-inch (M5)"` picks the simulator by name, on `RUNTIME="iOS 27"`
or the newest runtime that has it (default `iPhone 18 Pro`); `UDID=…` picks one
exactly.
`make run` opens no simulator window; follow the app with `make logs`.

- **`test-kit`** runs the package tests on macOS, with no simulator. **`test`** runs
  them, then the UI tests, which need no network: they point the app at a worker
  that is not there and set `SATVIS_TEST_CATALOG`, which starts a Debug build
  from a fixed catalog (`TestCatalog.swift`, `UITestCatalog.json`, which the
  Release configuration's `EXCLUDED_SOURCE_FILE_NAMES` leaves out) with black
  star maps beside it, as the real ones are fetched and kept, open the
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
  stopped at the time its test names (`SATVIS_TIME`, which opening a bookmark
  leaves stopped), from the site `BASE_URL` names (satvis.space by default). Each shot is taken on its own, under a status
  bar reading its time and date, as the clock deck does. `SHOTS=2Sky` retakes
  only the shots it names, for one whose tiles had not loaded.
- **`screenshots-upload`** replaces the screenshots of the version being prepared
  with `screenshots/*.png` through `asc` (`scripts/screenshots-upload.sh`), in
  the app's primary language, each file to the display type its size fits. It
  stops before changing anything at a file of no App Store size or a display type
  with no file, as asc would skip the one and stop halfway at the other. It signs
  in with asc's profile, whose API key needs the App Manager role. `DRY_RUN=1`
  says what it would replace.
  App Store Connect then checks each file, which took from seconds to over 20
  minutes a file on 2026-10-08; asc waits 10 minutes (`ASC_UPLOAD_TIMEOUT`), and
  what it uploaded stays, so a run that times out is simply run again.
- **`screenshots-download`** writes the screenshots of the version being
  prepared, else the live one, or `VERSION=1.1`, in the app's primary language,
  to `screenshots/app-store/` under the names they were uploaded with. App Store
  Connect re-encodes them, so they are not the uploaded bytes.
- **`metadata-download`** replaces `metadata/` with the listing's text, one JSON
  file per language, indented so that a changed field is a changed line: the
  name, subtitle and privacy policy in `app-info/`, and the description,
  keywords, URLs and release notes of the version being prepared, else the live
  one, or `VERSION=…`, in `version/<version>/`. Categories, age rating, review
  information and copyright are not in it (`asc metadata --help`).
- **`metadata-upload`** validates `metadata/` and updates the listing from it: the
  app info, and the version the one folder in `version/` names, which has to be
  editable. A field a file leaves out is left as it is. `DRY_RUN=1` lists the
  changes.

The App Store Connect listing (versions, builds, TestFlight, review) is managed
with the `asc` CLI (App Store Connect CLI). The Makefile exports the app's id,
`ASC_APP_ID=1441084766`, which asc and `scripts/asc.sh` read: `asc status --app
1441084766` shows where the release stands, and `asc validate` what blocks its
submission. `ASC_READ_ONLY=1` refuses every change. Its command catalog is
`docs/ASC.md`; regenerate it from the repository root with `asc init --path
ios/docs/ASC.md --link=false --force`, since a bare `asc init` writes to the root
and appends to the top-level `AGENTS.md`.

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
  without the worker serves its index.html for any path. When each is asked for
  is `GroupLoader`'s, above it: the app never waits on the worker for what a copy
  can show, so the index and each group come from the kept copy first, one load a
  group at a time, the worker's answer replaces them when it lands, and a return
  to the foreground asks again for every group loaded. Requests time out after 15 s.
- Work that grows with the number of satellites stays off the main thread, or is
  done only when its input changes: the GPU buffers are packed by
  `GlobeRenderer.prepare`, `CatalogModel.activeEntries` is kept rather than
  worked out on every read, `PassModel` publishes `PassStore`'s passes only
  when they change, and the station links are rebuilt only when the passes
  change. Past 500 active satellites the links are not drawn, as the web app
  switches them off.
- Tags and presets come from the group index, not from the app.

## Parity with the web app

`SatvisKit/Tests/SatvisCoreTests/Fixtures/parity.json` is what the web app's own
code answers for the element sets in `parity-input.json`: positions, the sampling
grid, the sun and the sky view's visibility verdict, the info panel's facts and chips, and passes over three ground stations in both
overpass modes, with the rows, headline and timeline strip the panel makes of
them. It also holds the URL codec's answers (`urlCodec.ts`, with vue-router's
query parser and serializer): each kind of parameter on awkward input, and whole
links read onto a preset and written back, over the parameters and vocabularies
the app honours (`LinkCodec`). `SatvisCore/Shared/web-tables.json` is the web
app's SATCAT labels and external links, read as they are. Regenerate both with
`pnpm update-parity-fixtures` at the repository root; never edit them by hand. CI
fails while it is stale. The fixtures' text is formatted in en-US, and the suites
that compare it pin `Formats.locale` to en_US (`.formatsInEnglishUS`), whatever the
machine's region. SGP4 states agree with satellite.js to under a
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
  view before it can find it. The info panel's `FactRow` reads as one element
  labelled `"<label>, <value>"`, not as two texts.
- **A simulator keeps its cached launch screen across reinstalls.** Judge
  launch-screen changes on a simulator that never had the app, or after
  `simctl erase`; the screen shows for ~1.5 s, so record it with
  `simctl io <udid> recordVideo`.
- **An open Xcode rewrites `project.pbxproj`** — it re-sorts entries you added by
  hand. Close the project before editing the file, or expect the churn.
