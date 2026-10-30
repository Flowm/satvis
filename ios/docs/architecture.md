# Architecture — iOS app

The app part by part: where each part lives, why it is built so, and what has to
change with it. `../AGENTS.md` has the module map and how to build and test.

## The globe's surface

- The globe's surface is a quadtree of geographic tiles (`Surface`), each with
  a texture baked from the base map (`Imagery.swift`), as ADR 0009 has it.
  Natural Earth's level 2 is under every tile: the app target's "Copy Natural
  Earth" phase copies it from the web app's `data/imagery` rather than keeping a
  second copy. Tiles come through `TileFetcher`'s cache in Caches, which the
  system may purge; Natural Earth's levels 3 to 5 are kept for good instead
  (`KeptTiles`).
- Terrain (`Terrain.swift`) is Re:Earth's quantized mesh, decoded and kept per
  terrain tile; a surface tile's grid is laid over the terrain tile log₂(screen
  scale) levels coarser, since the surface is refined in device pixels where
  CesiumJS counts CSS pixels: the level the web app would ask for, so the app
  asks Re:Earth no more than the web app does. ADR 0009 has why. iOS's memory
  warning drops what the last frame does not use (`GlobeRenderer.trimMemory`),
  about 175 MB after the sky view.
- The credits are About's Acknowledgements (`AcknowledgementsView`), the map's
  from `Credit.map`. Only OpenStreetMap wants its name in sight of the map, and
  of the maps only the terrain uses its data: `OpenStreetMapCredit` shows it on
  the clock deck for five seconds from when the terrain is drawn. The terrain's
  sources are copied from Re:Earth's `layer.json`, which CesiumJS reads at run
  time; check them against it when the terrain changes.

## Rendering

- `SatvisRender`'s shaders are `Shaders/*.msl`, compiled at run time by
  `ShaderLibrary` off the main thread, so neither the build nor CI needs Xcode's
  separately downloaded Metal toolchain. `RendererTests` compiles them on macOS,
  which is where a shader error shows. The atmosphere, lighting and tone mapping
  are CesiumJS's, ported, with the web app's defaults: a ported file keeps
  Cesium's Apache 2.0 notice and says what changed, and `LICENSE.CesiumJS.md`
  stays beside them, verbatim.
- The renderer works in the Earth-fixed frame in metres, relative to the eye,
  with reversed-Z depth and no far plane. Satellites are placed by high/low
  float pairs, in vertex functions compiled with safe math, which fast math
  could regroup; the globe's tiles are drawn relative to their centres, offset
  from the eye in double precision on the CPU. Which other functions take fast
  math, and what safe math cost, is `ShaderLibrary`'s. An iPad mini's GPU cost
  for the orbits followed the vertices it sorted into tiles, not the pixels:
  drawing those behind the Earth with no width took it from 57 to 33 ms a frame
  with every active satellite's orbit, where cheaper pixels saved 4, and past
  1,000 satellites a near-circular orbit's line steps over samples
  (`lineStride`). The ground tracks and sensor cones are `Footprints.swift` and
  `Shaders/Footprints.msl`, the tracks drawn into a cube map the globe samples
  (ADR 0009).
- 3D models are the web app's own files, fetched from the site's
  `/data/models/` by the `model` a record carries (`SatelliteModel`) and cached
  as the tiles are; `ModelAsset` reads only the parts of glTF that `data/models`
  uses, with Draco behind `DracoBridge`. Their size on screen, the point and
  label around a model, which copy is drawn (`ModelLevel`, ADR 0007) and the
  tracking distance follow the web app's `componentKinds.ts` and its `ModelSize`
  class; the info panel's close-up (`ModelCloseUp`) follows its
  `ModelCloseUp.ts`.
- The star maps are the web app's `DeepStar1K` and `DeepStar2K`, the Map
  panel's choice (`StarMap`, `StarMapName`), fetched from the site and kept like
  the GP data (`GroupRepository.starMap`), not shipped: `data/starmap/` is built
  with Docker by `pnpm update-starmap` and not committed, so the app target has
  none to copy in as it does Natural Earth. The 2K map's cube texture,
  mipmapped, is 129 MiB of GPU memory where the 1K one's is 32.
- A frame the GPU fails is logged (category `gpu`) and reported once per
  `MTLCommandBufferError` code as a PostHog exception
  (`GlobeRenderer.onGPUFault`): after one, iOS refuses the app's later frames
  and files no crash report.

## Session, links and gestures

- `Session`, owned by `SatvisApp`, is one open globe: the models, what is
  selected, followed and stood on and what a tap does (`Focus`, in SatvisCore,
  which says what the camera has to do), and the work that keeps them in step.
  It sets the globe up through `GlobeBinding`, in SatvisRender, which keeps what
  it was given and replays it to a renderer that arrives late, once its shaders
  compile. It watches the models with `Observations` rather than taking
  callbacks, so anything can watch them too. The views read it and call it and
  hold nothing else but what is on screen, so that what opens the app with a
  state of its own (a link, a restored scene) sets it in one place.
- A link is the view, as on the web (ADR 0001): `LinkCodec` reads one onto its
  preset's defaults, `SceneState` turns that into the app's terms and back, and
  `Session.open` applies it, replacing what is shown; `Session.link` writes the
  view back. Parameters the app does not honour (`surface`, `msaa`…) are kept as
  they came and written into every link it makes. Past a component's budget it
  switches off once, on the crossing, as on the web (ADR 0001,
  `ComponentBudgets`); labels past theirs are not drawn even when switched back
  on, as their atlas would outgrow a texture. Sharing is the Bookmarks sheet's,
  which hands the system's share sheet the link itself, so that it shows the
  site's own preview. The top-right corner is the web app's `#toolbarRight`,
  with the same buttons and labels, and Hide UI is the Graphics panel's first
  row, as on the web. The web offers the compass only where the browser has
  device orientation; the camera is the app's alone (ADR 0013). On an iPad, as
  on the web, the column hides under the info card, which has its own Track and
  Close; an iPhone's info sheet leaves it in place. satvis.space links open the
  app as universal links: the site's
  `public/.well-known/apple-app-site-association` claims `/ot` and `/` with a
  query, and `satvis.entitlements` the `applinks:satvis.space` domain, which
  needs the Associated Domains capability on the App ID. The simulator builds
  here are unsigned and carry no entitlements, so a universal link needs a
  signed build on a device; `SATVIS_LINK` takes the same path from
  `Session.run`: applied and recorded as an opened link.
- The globe's gestures are SwiftUI's, not UIKit recognizers on the MTKView, so
  the controls laid over it take the touches that land on them. They go to the
  renderer, which steers whichever camera its `CameraMode` says is in use: the
  free one over the globe, one following a satellite or a station, or the sky
  view's. A camera ignores a gesture that is not finite: once two fingertips
  meet, RotateGesture reports NaN, and a NaN heading drew a black globe until
  relaunch (TestFlight build 15). A camera that is not finite anyway is put back
  home and logged as a fault.

## The sky view

- The sky view (ADR 0003) is the same renderer from the ground (`SkyCamera`,
  `SkyFlight`). The crosshair, the tapes, the trace and the card read the
  renderer's last frame (`DrawnFrame`, `SkyTargets.swift`). The lock places only
  the satellites near the crosshair, by each one's direction kept for a second
  of the clock: placing all 16,755 active ones cost an iPad mini 8.6 ms of the
  main thread, 15 times a second (14 measured), and with them a Debug build
  managed 5 frames a second. The lock's card is the web app's (`SkyCard`, held
  to `skyCard.ts` by the parity fixtures), its numbers en-US whatever the
  region, unlike every other number and date, which follow it (`Formats`, ADR
  0015). Compass aiming (`SkyCompass`) can only be tried on a device: the
  simulator has no motion sensor. Where it stands is the web's (ADR 0003): the
  one station named "Geolocation", moved to the device each time, unless a link
  or a station's panel names one; the app writes the observer first into the
  links it makes, as a link's sky view stands on its first station. What cannot
  be seen (ADR 0010) is dimmed or hidden by the point and label shaders, from
  the frame's sun and how dark the observer's sky is (`SkyJudgement`): per
  satellite on the CPU it would cost what the lock costs, every frame. A dimmed
  3D model is drawn blended whole; the card's verdict is the same `Visibility`,
  in double precision. The camera's picture can show behind it (ADR 0013,
  `SkyPassthrough`, `CameraLens`); whatever stops the compass stops the camera,
  in `SkyAim.watchAiming`. The simulator has no camera: check it on a device.

## The 2D map

- 2D is the web app's flat map (ADR 0009), the Globe panel's 3D | 2D and a
  link's `scene=2D`: CesiumJS's SCENE2D in its geographic projection, drawn from
  `MapCamera` (centre, span across the view's longer side, heading). The rig
  keeps it beside the globe camera; a switch keeps the place, from the globe's
  centre at its scale, or the web app's opening view (five radii across, 287°)
  from where the whole disc shows, and back. The map repeats east and west and
  zooms out to its whole width across the view, no further, so a point is drawn
  once, at the copy nearest the centre (`MapCamera.maximumSpan`). Each pass has
  a 2D vertex function in `Shaders/Map.msl`, so 3D's are untouched, and the
  map's own draws are `MapPass`'s: positions are metres of the map from the
  view's centre, a satellite placed by Bowring's geodetic latitude as Cesium's
  2D places it (`geodeticPosition` on the CPU, `mapPosition` in the shaders,
  which taps and placed stations go back through, `DrawnFrame`). Tiles are the
  globe's, laid flat by their texture coordinates and refined by metres per
  pixel, without terrain; a line's segments are quads of their own, so none
  stretches across the map at the antimeridian. The orbit there is Cesium's
  path, where the satellite is at each instant, not the inertial ring of 3D: on
  the map that ring left the satellite's own path. No stars, atmosphere or
  sensor cones, as on the web. Tracking holds what it follows in the middle at a
  scale of its own, which a switch of projection carries over from the tracking
  camera's range and back; a drag does nothing. The sky view is drawn in 3D and
  goes back to the map. A change of projection draws one frame more of the old
  one, keeps it, and fades it out over the new for 0.35 s (`ProjectionFade`), so
  it covers the landing out of the sky view too.

## Panels

- The menu column and its panels are the web app's (`Satvis.vue`'s `menuItems`
  and its toolbar panels; `ToolPanels.swift`, filled in `SatvisApp.swift`): the
  same entries, Lucide icons and order, the hover hints trimmed to what the app
  has and read by VoiceOver, and each panel less what the app does not draw.
  Every surface over the globe is drawn (`PanelStyle.swift`) rather than Liquid
  Glass, whose blur cost the compositor 5 ms of GPU a frame. Not system menus:
  iOS 26 grows one out of its control, in the column's place, and it holds
  ticked lists alone.
- Bookmarks are the web app's (ADR 0011, `BookmarksView.swift`): the code that
  describes and names them (`Bookmarks` in SatvisCore) is held to its
  `src/modules/util/bookmarks.ts` by the parity fixtures. A bookmark's picture
  is the renderer's next frame (`GlobeRenderer.snapshot`), a demo's the site's
  `showcase/` picture (`GroupRepository.image`). A launch on the test catalog
  keeps its bookmarks apart, so every UI test starts with none.
- The Globe panel's camera mode is the web app's `camera` (`CameraFrame`, kept
  in links): Fixed, or Inertial, where the free camera is turned back each frame
  by as far as the Earth has turned (`OrbitCamera.holdInertial`, the Greenwich
  hour angle the satellites are rotated by), so the Earth turns under it and a
  scrubbed clock spins it.

## The Graphics panel

- The Graphics panel's "FPS" is the web app's FPS switch, kept in links as
  `fps=true` as the web keeps it (`PerformanceOverlay.swift`, `FrameStats`).
  Read it on a device: the simulator runs on the Mac's CPU and GPU. For where
  the time goes, profile a Release build with Instruments' Time Profiler
  (`xcrun xctrace record --template "Time Profiler" --attach <pid>`). Pointing
  `SATVIS_API` at `https://satvis.space`, without the slash, measures the real
  data and counts nothing (see Analytics).
- The Graphics panel's "Pixel ratio" is the web app's (`pixelratio`, kept in
  links): the globe drawn at 1 or 1.5 pixels a point instead of the screen's
  own, which the system scales up (`ScaledMTKView` in `GlobeView.swift`). The
  renderer sizes everything placed on the screen in points times the drawable's
  pixels a point, labels included, so only the sharpness changes; the map
  refines a level less, as its error is measured in the drawable's pixels. On an
  iPad mini, before the shaders took fast math, the default view took 10.5 ms of
  GPU a frame at native, 6.7 at 1.5 and 2.8 at 1.
- The Graphics panel's "Frame rate" caps the globe at 30 or 60 frames a second,
  or Max, the screen's own (`preferredFramesPerSecond`, 120 asked): 120 on a
  ProMotion screen, which an iPhone gives an app only with
  `CADisableMinimumFrameDurationOnPhone` in `Info.plist` (without `OnPhone` it
  is ignored, and held 120 to 60). The simulator reports 60 whatever it models.
  That rate is a cap: a frame is skipped, and the last one left on screen, while
  nothing has been set or loaded, the camera stands still and no satellite can
  have moved half a device pixel, as the web app paces CesiumJS's render on
  demand (`RenderPacing`; the default view draws 4 frames a second). Whatever
  changes what is drawn has to say so (`needsDraw`, or the surface's, the
  models' and the ground tracks' revisions). While the frames fall behind, a
  frame begins only once a drawable is free (`DrawableGate`): MTKView's
  `currentDrawable` blocked the main thread 20 ms a frame with every active
  orbit. A `CAMetalDisplayLink` dropped 2 % of the sky view's frames, called
  after SwiftUI's redraw of its instruments. A frame is drawn for the instant it
  will be shown (`FramePresentation`): the clock and the flights, not a drag.
  Every active orbit on an iPad mini, shown 16.7 or 33.3 ms apart, then moves by
  the screen's steps in 99 % of the frames rather than 30 %. The rate stays the
  one chosen, not a steady divisor below it: at 45 fps the eye trails a
  satellite 12.6 ms on average, at 30 16.7.
- The Graphics panel's "Benchmark" is the web app's `bench=true`, kept in links
  the same way (`Benchmark.swift`, `BenchmarkPanel.swift`,
  `BenchmarkReport.swift`): each scene's link opened in turn, waited for until
  everything active is drawn (`SatelliteLayer.draws`), then settled and recorded
  (`FrameRecording`). `process_cpu_pct` is every thread's, SwiftUI's included,
  which the sky view's instruments spend more of than its renderer. `memory_mb`
  and `gpu_memory_mb` carry what earlier scenes left cached. A frame's GPU span
  includes other work the GPU does meanwhile, such as SwiftUI drawing the sky
  view's instruments. Bump `Benchmark.version` when the scenes or the metrics
  change. `SATVIS_BENCHMARK` in the launch environment runs it at once, sends
  the results itself and prints them as JSON, for a device driven from the Mac;
  `SATVIS_BENCHMARK=print` only prints them, and `SATVIS_BENCHMARK_SCENES`
  (scene ids by commas) runs only those:
  `xcrun devicectl device process launch --console --device <name> --environment-variables '{"SATVIS_BENCHMARK":"1"}' org.frcy.app.satvis`.

## Element sets, stations and passes

- Every element set reaches SGP4 as OMM keywords (`MeanElements`). The worker's
  pseudo element sets still arrive as TLE lines; they are read into the same
  keywords at parse time, and Vallado's `twoline2rv` is never called.
- Ground stations are kept in `UserDefaults` and synced nowhere (ADR 0009). A
  station has an id, and everything that refers to one holds the id, not its
  place in the list or its name: the open panel, the renderer's marker
  (`station|<id>`), each pass, and an alert, which is dropped with its station.
- Pass notifications (`PassAlerts`) are kept rather than sent once, as the web
  app sends them: the subjects are saved, and every launch, return to the
  foreground and background refresh predicts them again from the newest element
  sets and replaces the pending ones with the earliest 64, iOS's limit, two a
  pass (`PassNotificationPlan`). Over a busy station those can run out within
  hours, so the app asks to be woken before they do (the `.backgroundTask` in
  `SatvisApp.swift`). To run that refresh, pause the app in the debugger and
  `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"org.frcy.app.satvis.passes"]`.

## Privacy and analytics

- `satvis/PrivacyInfo.xcprivacy` is the privacy manifest App Store Connect
  requires: no tracking; product interaction collected for analytics, and a
  coarse location (the sky view's station, to the whole degree, in a page view's
  link), and performance data (the benchmark's results, sent by hand, and a
  frame the GPU failed, a hang as Apple counts one), all linked to no one;
  `UserDefaults` read by the app alone, and the system uptime the renderer's
  flights are timed by. The PostHog package brings its own manifest for the APIs
  it uses and the usage data it sends, and its crash reporter one claiming crash
  and diagnostic data, which nothing collects: crash capture is off. Add to the
  app's with every required-reason API and every data type collected, and keep
  the App Store privacy label in step with it.
- Analytics (`Analytics.swift`) is posthog-ios, reporting to the web app's
  project (ADR 0009): a `$pageview` of the view's link whenever the view
  changes, the clock aside (toggling the FPS switch or the benchmark panel
  counts, as it does on the web), its ground stations cut to the whole degree as
  the web's `posthogPrivacy.ts` does (`sanitizedForAnalytics`, held to it by the
  parity fixtures). It reports only from a release build whose site is
  `https://satvis.space/` exactly (`WorkerClient.production`), with PostHog's
  project key and host, which are not committed: copy
  `Config/Analytics.example.xcconfig` to the gitignored
  `Config/Analytics.xcconfig` (`Config/Base.xcconfig`), and check a change with
  a Release build in the simulator, whose events carry `$is_emulator`. Opted out
  ("Share usage data" in About), PostHog is not set up at all, so nothing is
  sent, not even its remote config.

## Packaging

- `Info.plist` is generated from `INFOPLIST_KEY_*` build settings. The file
  `satvis/Info.plist` holds only the keys that have no build setting.
- The app icon (`AppIcon.icon`) and the launch image are cut from
  `public/logo.svg`: counting its `<path>`s from 0, 0 is the #0b222d background,
  1–3 sky, 4–6 hills, 7–49 shuttle and 50–51 exhaust. Cut them again when the
  logo changes.
