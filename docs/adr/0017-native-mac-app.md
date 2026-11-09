---
status: accepted
---

# A native Mac app, from the iOS app's own target

satvis 2.2 adds the Mac. It is the native app (ADR 0009) built for macOS from the
same Xcode target, files and bundle id, so one purchase covers iPhone, iPad and Mac,
and every change to the app reaches both. Apple TV comes later, as a target of its
own.

## Decision

**Native SwiftUI on AppKit, not Mac Catalyst and not the iPad app on the Mac.**
SatvisKit, the globe included, already built and tested on macOS: only the app
target's UIKit glue stood in the way, 46 compile errors in 14 files. Catalyst would
still feel like an iPad, and needs a Draco built for it, which DracoSwift does not
ship. The iPad app on an Apple silicon Mac ("Designed for iPad") costs nothing, but
brings touch semantics and no menus or scroll-wheel zoom; the target no longer
offers it (`SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD = NO`).

**One multiplatform target.** The Mac's window is laid out as an iPad's, the menu
column open and the info panel a card, which is the web app's desktop layout, so
the views are shared. What differs is behind `#if`, through `Platform.swift` where
a call has a counterpart on each side, and what one side alone has sits in
`satvis/iOS/` or `satvis/macOS/`, each left out of the other's build by
`EXCLUDED_SOURCE_FILE_NAMES`. A second Mac target sharing the folder was the
alternative: its own Info.plist and entitlements without conditional settings, but
two targets' settings, packages and phases to keep in step, and the same `#if`s in
the shared files. If the conditional settings outgrow the target, splitting it then
is a new target over the same folder.

**Apple silicon only.** macOS 26, as iOS 26, arm64 alone. macOS 26 is the last
release that runs on Intel, and an Intel Mac would draw through the renderer's
untested path for GPUs without tile memory.

**Apple TV is not this target.** Its input is a remote and focus, not a pointer, and
its views share little with these. It will be a target of its own, which needs the
app's models moved into SatvisKit first; that move waits for the TV, since the Mac
does not need it.

## Consequences

- **What a Mac has not**: no compass and no camera facing the sky, so the sky view
  is aimed by dragging, as the web app's on a desktop (ADR 0004); `SkyCompass` and
  `SkyPassthrough` have Mac stand-ins that refuse, and their controls are not
  shown. No background refresh: the pass notifications are planned again on a
  timer while the app runs, and those scheduled still come once it quits.
- **The sandbox** is the Mac App Store's requirement (`satvis-macOS.entitlements`).
  An unsigned build, as `make run-mac` makes, runs outside it, where Application
  Support and Caches are the user's, shared by every app, so the app keeps to a
  folder named by its bundle id in them.
- The Mac's Info.plist is `satvis/macOS/Info.plist`; keys only an iPhone takes are
  written in `satvis/Info.plist` rather than as build settings, which would put
  them, empty, into the Mac's too.
