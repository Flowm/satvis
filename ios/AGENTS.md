# AGENTS.md — iOS app

The native app: SwiftUI with no web view, reading the same worker as the web app.
Xcode 27, Swift 6 with MainActor default isolation in the app target, iOS 26 and
later. Xcode Cloud builds, numbers and publishes every release; there is no
fastlane. Why it is built this way, and the milestones it is built in, are in
`docs/adr/0007-native-ios-app.md`. The WebView app it replaces is the tag
`ios-webview-final`.

## Layout

- `SatvisKit/` is a local Swift package holding everything that is not a view.
  `SatvisCore` holds element sets, the group index, and the arithmetic the web app
  does on them. `SatvisData` holds the worker client, its disk cache, and the
  snapshot shipped in the app. The app target holds only views and their models.
- `satvis/` and `satvisUITests/` are folder-synchronized: a file added on disk joins
  its target, with no `project.pbxproj` edit. A new package product does need one.
- `Info.plist` is generated from `INFOPLIST_KEY_*` build settings. The file
  `satvis/Info.plist` holds only the keys that have no build setting:
  `UILaunchScreen`, and `NSAppTransportSecurity` to allow a local worker.
- `satvis/lib/NotificationManager.swift` is the WebView app's pass-notification
  scheduler, unused until the passes milestone (M3).
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
  them, then the UI test, which needs no network: it points the app at a worker
  that is not there and reads the kept copy or the snapshot.
- **`run API=…`** installs and launches against another worker, e.g. a local one
  at `http://localhost:8080` (`pnpm dev:worker` at the repository root).
- **`snapshot`** refreshes the snapshot shipped in the app from satvis.space (or
  `API=…`): the group index and the groups the default preset enables. Run it
  before a release.
- **`screenshots`** erases one simulator per App Store size and writes
  `screenshots/`. Upload them to App Store Connect by hand.

## The worker

- `SATVIS_API` in the launch environment replaces satvis.space: `make run API=…`,
  or a scheme environment variable in Xcode.
- `GroupRepository` revalidates every payload with its ETag, keeps it in
  Application Support, and falls back to the kept copy, then the snapshot, when
  the worker cannot be asked. A 200 that is not JSON counts as no answer: a host
  without the worker serves its index.html for any path.
- Tags and presets come from the group index, not from the app.

## Parity with the web app

`SatvisKit/Tests/SatvisCoreTests/Fixtures/parity.json` is what the web app's own
code answers for the element sets in `parity-input.json`. Regenerate it with
`pnpm update-parity-fixtures` at the repository root; never edit it by hand. CI
fails while it is stale. The rotation into the pseudo-fixed frame is Cesium's
GMST polynomial, not satellite.js's `gstime`, and the port has to stay operation
for operation (`GreenwichHourAngle.swift`).

## Gotchas

- **`make test` never exits after a failed test**, nor does the `xcodebuild` under
  it. Watch the output for `Test Suite 'All tests' failed` and stop it.
- **A lazy `List` has no rows off screen**, so a UI test has to scroll a row into
  view before it can find it. `LabeledContent` reads as one element labelled
  `"<label>, <value>"`, not as two texts.
- **A simulator keeps its cached launch screen across reinstalls.** Judge
  launch-screen changes on a simulator that never had the app, or after
  `simctl erase`; the screen shows for ~1.5 s, so record it with
  `simctl io <udid> recordVideo`.
- **An open Xcode rewrites `project.pbxproj`** — it re-sorts entries you added by
  hand. Close the project before editing the file, or expect the churn.
