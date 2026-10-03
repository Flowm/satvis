# AGENTS.md — iOS app

A SwiftUI shell around a `WKWebView` that loads <https://satvis.space>. The app adds
what the PWA cannot: local pass notifications, and the page's service worker
through App-Bound Domains. Xcode 27, Swift 6 with MainActor default isolation.
Xcode Cloud builds, numbers and publishes every release; there is no fastlane.

## Layout

- `satvis/` and `satvisUITests/` are folder-synchronized: a file added on disk joins
  its target, with no `project.pbxproj` edit.
- `Info.plist` is generated from `INFOPLIST_KEY_*` build settings. The file
  `satvis/Info.plist` holds only the keys that have no build setting:
  `UILaunchScreen` and `WKAppBoundDomains`.
- The deployment target stays `$(RECOMMENDED_IPHONEOS_DEPLOYMENT_TARGET)` on purpose.
- The app icon (`AppIcon.icon`) and the launch image are cut from `public/logo.svg`:
  counting its `<path>`s from 0, 0 is the #0b222d background, 1–3 sky, 4–6 hills,
  7–49 shuttle and 50–51 exhaust. Cut them again when the logo changes.

## Tasks

`make` in `ios/` runs them: `build`, `test`, `run`, `logs`, `format`, `lint`,
`screenshots`, `clean`. `DEVICE="iPad Pro 13-inch (M5)"` picks the simulator by name,
on `RUNTIME="iOS 27"` or the newest runtime that has it (default `iPhone 17`);
`UDID=…` picks one exactly.
`make run` opens no simulator window; follow the app with `make logs`.

- **`test`** launches the app against satvis.space and checks the page renders;
  it needs the network.
- **`run URL=…`** installs and launches with the page replaced.
- **`screenshots`** erases one simulator per App Store size and writes
  `screenshots/`. Upload them to App Store Connect by hand.
- **Inspect the page:** Debug builds are inspectable from Safari's Develop menu.

## The web page

- `URL` in the launch environment replaces satvis.space: `make run URL=…`, or a
  scheme environment variable in Xcode.
- Hosts in `WKAppBoundDomains` (satvis.space, localhost) get a web view limited to
  them, which is what lets the service worker run. Any other host loads unlimited
  and without one. External links always leave for Safari.
- The bridge is one message handler, `iosNotify`, posting
  `{message, delay, date}` from `src/modules/util/PushManager.ts`. It schedules a
  local notification `delay` seconds out, keeping the 60 soonest.
- Permissions are asked on use: WebKit raises the location prompt when the page
  calls `navigator.geolocation`, and the first `iosNotify` raises the
  notification prompt. User agents carry `SatvisApp/<version>`.

## Gotchas

- **`make test` never exits after a failed test**, nor does the `xcodebuild` under
  it. Watch the output for `Test Suite 'All tests' failed` and stop it.
- **A simulator keeps its cached launch screen across reinstalls.** Judge
  launch-screen changes on a simulator that never had the app, or after
  `simctl erase`; the screen shows for ~1.5 s, so record it with
  `simctl io <udid> recordVideo`.
- **An open Xcode rewrites `project.pbxproj`** — it re-sorts entries you added by
  hand. Close the project before editing the file, or expect the churn.
