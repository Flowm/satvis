# satvis 2.2: native macOS and tvOS — research

Researched 2026-11-06 on `main` at 2612e038 (app 2.2, Xcode 27.2). Facts about
Apple platforms come from Apple's documentation unless a source says otherwise;
the build results were measured on this Mac today.

## In short

- **The hard part is already portable.** SatvisKit (SatvisCore, SatvisData,
  SatvisRender: 14,300 lines, the Metal globe included) already builds and tests
  on macOS. Today it also **built for tvOS with no change but `.tvOS(.v26)` in
  `Package.swift`**. Draco's prebuilt XCFramework has macOS and tvOS slices, and
  posthog-ios supports both.
- **The work is the app target** (8,500 lines of views and models). A trial
  compile of it, with the iOS-only imports fenced off, failed with **46 errors in
  14 files on macOS** and **27 errors in 5 files on tvOS**. Both are lower
  bounds: the compiler gives up on a file early, so `UIPasteboard`, the share
  sheet and `horizontalSizeClass` had not been reported yet.
- **macOS is a port.** The iPad's regular-width layout is already the web app's
  desktop layout. What is missing is AppKit glue, mouse and keyboard input, the
  menu bar, a window, and the sandbox.
- **tvOS is a new front end.** The globe, data and models carry over. The views
  and the input do not: there is no touch at a point, no drag or pinch, focus
  drives everything, and the platform has no persistent storage, no notification
  banners, no share sheet, no pasteboard, no compass and no camera.
- **Recommendation:** ship native macOS in 2.2. Start tvOS in 2.2 with a
  prototype of remote input over the globe, then decide whether it ships in 2.2
  or 2.3 (see "Decisions").

## What was measured

| Check | Result |
|---|---|
| `swift test` of SatvisKit on macOS | Already in CI (`.github/workflows/ios.yml`) |
| SatvisKit for `generic/platform=tvOS`, with `.tvOS(.v26)` added | **BUILD SUCCEEDED** |
| Draco.xcframework slices | ios, ios-sim, **macos (arm64, x86_64)**, **tvos**, tvos-sim, xros. **No Mac Catalyst** |
| App target for macOS, imports fenced | 46 errors / 14 files |
| App target for tvOS, imports fenced | 27 errors / 5 files |
| tvOS simulator runtime on this Mac | Not installed (the 27.2 SDK is). Device types up to *Apple TV 4K (4th generation)* are listed |

Errors on **macOS**, by kind:

- **`UIViewRepresentable` around `MTKView`** (`GlobeView`, `SatelliteModelView`):
  `didMoveToWindow`, `contentScaleFactor`, `traitCollection`, `backgroundColor`,
  `isOpaque`.
- **App delegate:** `UIApplicationDelegateAdaptor` (`SatvisApp`, `Analytics`).
- **UIKit types:** `UIImage` (`AboutView`, `BookmarksView`), `UIDevice`
  (`AboutView`, `Benchmark`), `UIPasteboard` (`InfoPanel`), `UIColor` and the
  grouped background colours (`PanelStyle`).
- **iOS-only frameworks:** `BGTaskScheduler` (`PassAlerts`), CoreMotion
  (`SkyCompass`), and the camera zoom and field-of-view APIs (`SkyPassthrough`).

Errors on **tvOS**, by kind:

- **Gestures:** `DragGesture`, `SpatialTapGesture`, `SpatialEventGesture` and
  `MagnifyGesture` do not exist (`GlobeView`, `SatelliteModelView`).
- **Panel styling:** `PanelStyle`'s grouped colours, `userInterfaceLevel` and
  `scrollContentBackground`.
- **Notifications:** the `title` and `body` of a notification (`PassAlerts`).
- **Sky view sensors:** CoreMotion and `UIInterfaceOrientation` (`SkyCompass`).

The renderer itself already has the platform guards it needs
(`#if canImport(UIKit)` in `FrameLoop`, `GlobeRenderer`, `ModelCloseUp`). It
also has a path for GPUs without tile memory: `ScenePipelines` uses the
tile-memory tonemap only where `supportsFamily(.apple4)`. That fallback has never
run on a real device, since every iPhone and iPad has an apple4 GPU or newer. An
Intel Mac would run it.

---

## macOS

Built in 2.2: ADR 0017 records the route and what the Mac does without, and
`docs/architecture.md`, "The Mac", how it was built. What was found here and
belongs to neither:

- Once two platforms are approved in App Store Connect, neither can be removed.
- Mac App Store screenshots are one of 1280×800, 1440×900, 2560×1600 or
  2880×1800, shot from the window: `scripts/screenshots.sh` has no Mac path yet.
- Xcode Cloud needs a macOS archive workflow; TestFlight works on a Mac.
- PostHog tells the platforms apart by `$os`; the privacy manifest and label are
  the same as iOS's.

---

## tvOS

### What carries over and what does not

| Feature | tvOS |
|---|---|
| Metal globe, terrain, models, stars, map | Yes (SatvisRender builds; MTKView, CoreText, `CAMetalDisplayLink` available) |
| Data, links, presets, propagation, passes | Yes (SatvisCore/SatvisData build) |
| Touch gestures on the globe | **No**: no Drag/SpatialTap/SpatialEvent/Magnify/Rotate. Continuous pan needs UIKit's `UIPanGestureRecognizer` (indirect touches) or `GCController.microGamepad` |
| Popover (globe menu, bookmarks, column) | **No**. Sheets, `fullScreenCover`, Menu (tvOS 17), Picker, Toggle, `contextMenu` exist. Slider/Stepper don't (unused today) |
| Search (`searchable`, TextField) | Yes, with the on-screen keyboard or iPhone dictation |
| Persistent storage | **No guarantee**: Apple's only text (2017) says 500 KB of `UserDefaults` is persistent and everything else must be purgeable (Caches). No newer document relaxes it |
| Pass notifications | **No**: tvOS notifications carry a badge only |
| Background refresh | `BGAppRefreshTask` exists, but there is nothing to refresh without alerts |
| Location | `requestLocation` and when-in-use authorization only, no continuous updates; accuracy undocumented (Wi-Fi/IP) |
| Compass, camera passthrough | **No** (no CoreMotion; the camera is only an iPhone through Continuity Camera) |
| Share, pasteboard, review prompt | **No** |
| Universal links | Supported, but rarely triggered on a TV |
| Top Shelf | Yes (`TVTopShelfContentProvider`, tvOS 13) |
| Widgets | No |

### Hardware

| Model | Chip | RAM | tvOS 27 |
|---|---|---|---|
| Apple TV HD | A8 | 2 GB | **dropped** |
| Apple TV 4K (1st gen, 2017) | A10X | 3 GB | **dropped** |
| Apple TV 4K (2nd gen, 2021) | A12 | 3 GB | yes |
| Apple TV 4K (3rd gen, 2022) | A15 (iPad mini 6's) | 4 GB | yes |
| Apple TV 4K (4th gen, ships 2026-11-13) | A19 | 8 GB (leaked, not Apple's) | yes |

RAM comes from Wikipedia and EveryMac; Apple does not publish it. Model support
comes from MacRumors and 9to5Mac. Every model outputs at most 2160p60.

- **Rendering cost.** The native default frame cost an iPad mini 6 (A15) 6.6 ms
  of GPU time at 2266×1488, about 3.4 Mpx. A 4K drawable is 8.3 Mpx, 2.5 times
  the pixels. A 1080p drawable is 2.1 Mpx. Default the TV to the Graphics
  panel's pixel ratio 1, which draws 1920×1080 and lets the system scale it up,
  on the A12 and A15. Measure the A19 before offering native 4K. Rendering
  already happens on demand, which suits a TV left on.
- **Memory.** No per-app limit is documented, and the
  `increased-memory-limit` entitlement does not exist on tvOS. On the 3 GB A12,
  keep to the 1K star map (the 2K cube is 129 MiB) and the existing
  `trimMemory`. `os_proc_available_memory()` reports the headroom at run time.
- **Minimum version.** **tvOS 27**: A12 and newer only. tvOS 26 would add the
  A8 Apple TV HD, an apple2 GPU with 2 GB, which is not worth the effort.

### Storage on tvOS

`PayloadStore` (GP data), `KeptTiles` and `BookmarkStorage` write to
Application Support. On tvOS:

- **GP data and kept tiles** go to Caches. Both can be downloaded again;
  `GroupLoader` already treats a missing copy as a first launch.
- **Stations, settings and the last view** stay in `UserDefaults`. They are a
  few KB, inside the 500 KB.
- **The user's own bookmarks** are the problem. Their pictures cannot persist,
  and Caches can be purged. Options:
  1. **Featured bookmarks only** on the TV.
  2. **Keep the bookmark links** in `UserDefaults` and draw the pictures again
     on demand.
  3. **iCloud** (`NSUbiquitousKeyValueStore`/CloudKit), shared with the iPhone.
     ADR 0009 dropped iCloud because it added a processor to the privacy
     policy; a TV is the case where it pays.

### Input and UI design (the real work)

The TV app is held with a Siri Remote from 3 m away. A proposal to prototype
first:

- **Touch-surface swipe** turns the globe continuously. Use a
  `UIPanGestureRecognizer` on a focusable `MTKView` subclass in a
  `UIViewRepresentable`. While the globe holds focus, it takes the swipes that
  would otherwise move focus.
- **Click up and down** on the clickpad ring zoom in steps (`onMoveCommand`,
  animated flights). Left and right step the clock, or select the next
  satellite.
- **Select** picks the satellite nearest a centre reticle. This reuses the sky
  view's lock: the satellites near the crosshair, read from `DrawnFrame`, as
  `SkyTargets` does. A long press opens the globe menu as a sheet.
- **Play/Pause** plays and pauses the clock (`onPlayPauseCommand`). **Back**
  closes the panel, then deselects, then leaves (`onExitCommand`).
- **Game controllers** (thumbsticks, triggers) can come later. App Review
  requires the Siri Remote alone to be enough.
- **Layout.** A screen of 1920×1080 pt.
  - Keep primary content 60 pt from the top and bottom and 80 pt from the
    sides.
  - Make everything focusable rows (`focusSection`, `defaultFocus`).
  - No popovers.
  - Text sizes for a TV.
- **Scope for a first TV release.**
  - The globe and the 2D map.
  - The Satellites browser and search.
  - The info card and tracking.
  - Featured bookmarks as "channels".
  - The clock deck.
  - Passes over a station placed by `requestLocation` or by search.
  - Leave out: pass alerts, share, the camera and compass sky view, and
    probably the benchmark.
  - A TV sky view aimed with the remote is possible later.
- **Top Shelf extension.** The featured bookmarks' pictures, from
  `GroupIndex.featured` and the site's images, each opening its link. It is
  cheap, and it is the most visible part of a TV app.
- **Ambient mode** would suit a TV: tour the featured bookmarks, or follow the
  ISS.
- **The bar to clear:** the iPhone app on AirPlay already puts the globe on a
  TV. A TV app has to be better than that.

### Project structure

- **A separate tvOS target**, `satvisTV`, with the same bundle id for universal
  purchase. Its views share little with iOS, and its Info.plist, icon and
  Top Shelf extension are its own.
- **Share the models first.** Move the app target's non-view code into a new
  SatvisKit library (for example `SatvisSession`): `Session`, `CatalogModel`,
  `PassModel`, `BookmarkModel`, `SatelliteLayer`, `ViewerClock`, `StarMap` and
  the core of `Analytics`. That is about 1,800 lines, and it pays off for the
  Mac and for tests too.
  - `Session` imports UIKit only for reduce-motion (two calls), which moves
    behind a small per-platform shim (`UIAccessibility` on iOS and tvOS,
    `NSWorkspace` on macOS).
  - `PassModel` and `SkyAim` use CoreLocation, which runs on all three.
- **The icon** is a layered image stack in the asset catalog. Icon Composer's
  `.icon` does not cover tvOS. Add a Top Shelf image of 2320×720 pt.
- **Screenshots** are 1920×1080 or 3840×2160.
- **Testing.** Install the tvOS simulator runtime
  (`xcodebuild -downloadPlatform tvOS`). UI tests drive the remote with
  `XCUIRemote`. Measure on an Apple TV 4K 2nd generation, the slowest
  supported model.

---

## Shared work for both

- **CI.** Add `.tvOS(.v26)` (or `.v27`) to `Package.swift`. Build SatvisKit and
  the app for `generic/platform=macOS` and `generic/platform=tvOS` in the GitHub
  iOS job. This catches UIKit leaking into shared code.
- **Xcode Cloud.** An archive workflow per platform. Each needs
  `ci_post_clone.sh`'s PostHog config, which the shared `Config/Base.xcconfig`
  already includes.
- **App Store Connect.** Add the macOS and tvOS platforms to app 1441084766.
  Each platform has its own version, screenshots and review. `metadata/` and
  `make screenshots*` gain a platform dimension. Check what the asc CLI offers
  for that (`docs/ASC.md`).
- **Docs.**
  - An ADR, "native macOS and tvOS apps", in the shape of ADR 0009, recording
    what each platform drops and why.
  - Platform notes in `ios/docs/architecture.md`.
  - `ios/AGENTS.md` gains the new targets and make tasks. The `ios/` folder name
    may want to become `apple/` at some point.
- **Parity.** Nothing changes: SatvisCore is shared, and its fixtures hold all
  three platforms.

## Suggested order

1. **Groundwork**, one PR:
   - Extract `SatvisSession`.
   - Add tvOS to the package.
   - Add the CI builds for macOS and tvOS.
2. **macOS:** built (ADR 0017), but for Mac UI tests and screenshots, and the
   Xcode Cloud workflow, then TestFlight.
3. **tvOS prototype:** a focusable `MTKView` that takes remote swipes, zooms by
   clicks, and selects by a reticle, run on an A12 Apple TV. It answers the two
   real risks, input under the focus engine and GPU time at TV resolution,
   before any views are built.
4. **tvOS app:**
   - The views to the scope above.
   - Storage moved to Caches.
   - The Top Shelf extension, the icon stack and screenshots.

## Decisions (2026-11-07)

1. **macOS route:** native SwiftUI, from the iOS app's own target (ADR 0017).
2. **Intel Macs:** not supported. arm64 only, macOS 26.
3. **tvOS timing:** after the Mac. 2.2 is the Mac.
4. **tvOS minimum:** open until the TV work starts; tvOS 27 is the recommendation.
5. **Bookmarks on TV:** iCloud sync looks useful, which reopens ADR 0009's
   decision against iCloud. To decide with the TV work.

## Not confirmed

- **tvOS storage rules.** Apple's text is from 2017, and nothing newer was found.
  Verify on a device that Application Support survives a purge, or does not.
- **Per-app memory limits on Apple TV.**
- **The A19 Apple TV's RAM.**
- **Location accuracy on tvOS.**
- **Whether adding macOS withdraws the iPad app from Apple silicon Macs.**
- **Xcode Cloud's official tvOS support.** Only a third-party blog confirms it.
