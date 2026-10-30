# AGENTS.md — iOS app

The native app: SwiftUI with no web view, reading the same worker as the web
app. Developed with Xcode 27, Swift 6 with MainActor default isolation in the
app target, iOS 26 and later. Xcode Cloud builds, numbers and publishes every
release; there is no fastlane. CI (`.github/workflows/ios.yml`) pins Xcode 27.0
and lints with its `swift format`: a newer formatter's rules can fail
`make lint` there. CI moves with the Xcode the app is developed on, since Xcode
26's compiler rejects code Xcode 27's accepts.

## Layout

- `SatvisKit/` is a local Swift package holding everything that is not a view:
  `SatvisCore` the element sets, propagation and the arithmetic the web app does
  on them, `SatvisData` the worker client and its disk cache, `SatvisRender` the
  Metal globe. The app target holds the views, their models and the session that
  ties them together. C++ sits behind C bridges, so no Swift module needs C++
  interoperability: `SGP4` is Vallado's reference C++, vendored byte for byte
  (`vallado/VENDOR.md`), and `DracoBridge` wraps Draco.
- `satvis/` and `satvisUITests/` are folder-synchronized: a file added on disk
  joins its target, with no `project.pbxproj` edit. A new package product does
  need one.

**Before adding, moving or looking for a file, or changing how any part of the
app works**, read `docs/architecture.md`, the app part by part.

**After changing what the app draws or how it answers a touch**, rerun the
checks in `docs/manual-verification.md` that cover it, and record what each
returned.

## Tasks

They are `make` targets in `ios/`; `make` alone (`make help`) lists them and the
variables they take. `make run` opens no simulator window; follow the app with
`make logs`.

- **`test`** runs UI tests that need no network: they start a Debug build on a
  fixed catalog with no worker to answer (`TestCatalog.swift`).
- **`screenshots`** erases one simulator per App Store size, the default
  `iPhone 18 Pro` among them, and shoots the Bookmarks sheet's demos on the live
  site (`scripts/screenshots.sh`). `SHOTS=2Sky` retakes one whose tiles had not
  loaded.
- **`screenshots-upload`** signs in with asc's profile, whose API key needs the
  App Manager role. App Store Connect then checks each file, which took from
  seconds to over 20 minutes a file on 2026-10-08; asc waits 10 minutes
  (`ASC_UPLOAD_TIMEOUT`), and what it uploaded stays, so a run that times out is
  simply run again.
- **`screenshots-download`** gets App Store Connect's re-encoding, not the
  uploaded bytes.

The App Store Connect listing (versions, builds, TestFlight, review) is managed
with the `asc` CLI, whose command catalog is `docs/ASC.md`. The Makefile exports
the app's id, `ASC_APP_ID=1441084766`; asc run directly needs it too, or
`--app 1441084766`. Regenerate the catalog from the repository root with
`asc init --path ios/docs/ASC.md --link=false --force`, since a bare `asc init`
writes to the root and appends to the top-level `AGENTS.md`.

## The worker

- `SATVIS_API` in the launch environment replaces satvis.space:
  `make run API=…`, e.g. a local worker at `http://localhost:8080`
  (`pnpm dev:worker` at the repository root), or a scheme environment variable
  in Xcode. `SATVIS_TIME` (ISO 8601, UTC) pins the clock at that instant and
  pauses it, for screenshots and for checking the lighting. `SATVIS_LINK` opens
  on a link, a whole url or a path with its query (`/ot?tags=OT`), ahead of the
  view a last run left.
- The app never waits on the worker for what a kept copy can show
  (`GroupLoader`, over `GroupRepository`). It ships no catalog: a bundled one is
  weeks out of date by the time most people install, and the first answer
  replaces it anyway.
- Work that grows with the number of satellites stays off the main thread, or
  is done only when its input changes: the GPU buffers are packed by
  `GlobeRenderer.prepare`, `CatalogModel.activeEntries` is kept rather than
  worked out on every read, `PassModel` publishes `PassStore`'s passes only when
  they change, and the station links are rebuilt only when the passes or the
  active satellites change.
- Tags and presets come from the group index, not from the app.

## Parity with the web app

`SatvisKit/Tests/SatvisCoreTests/Fixtures/parity.json` and
`SatvisCore/Shared/web-tables.json` are written from the web app's own code by
`pnpm update-parity-fixtures` at the repository root; never edit them by hand.
Their text is en-US: a suite that compares it pins `Formats.locale` with
`.formatsInEnglishUS`, or it fails on a machine in another region. The Swift
held to them follows the web app operation for operation, down to JavaScript's
whole-millisecond Dates: the satrec set up as satellite.js sets it up
(`MeanElements`, `SGP4Propagator`), Cesium's GMST polynomial rather than
satellite.js's `gstime` (`GreenwichHourAngle.swift`), and pass prediction
(`PassFinder`) as `Orbit.ts` does it, step for step. Arithmetic that is right
but not the web app's can fail the parity tests, which hold positions to a
centimetre.

## Gotchas

- **`make test` never exits after a failed test**, nor does the `xcodebuild`
  under it. Watch the output for `** TEST FAILED **` and stop it.
  `Test Suite 'All tests'` also appears once before that, from the package tests
  that run first.
- **An edit made while `xcodebuild` is building can be left out of it**, and
  the UI test then runs the previous build: its failures name lines of the old
  file, and the log lacks steps the source has. `touch` the file and run again.
- **A lazy `List` has no rows off screen**, so a UI test has to scroll a row
  into view before it can find it. The info panel's `FactRow` reads as one
  element labelled `"<label>, <value>"`, not as two texts.
- **A simulator keeps its cached launch screen across reinstalls.** Judge
  launch-screen changes on a simulator that never had the app, or after
  `simctl erase`; the screen shows for ~1.5 s, so record it with
  `simctl io <udid> recordVideo`.
- **An open Xcode rewrites `project.pbxproj`** — it re-sorts entries you added
  by hand. Close the project before editing the file, or expect the churn.
