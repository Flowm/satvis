# Architecture — iOS app

The app part by part: where each part lives, why it is built so, and what has to
change with it. `../AGENTS.md` has the module map and how to build and test.

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
  as they load, the parent tile's texture standing in, and the
  nearest loaded ancestor where that is not complete. A Mercator tile's
  texture coordinates are worked out in double precision on the CPU, a strip of
  rows at a time: a float cannot place a pixel at level 19. Tiles come through
  `TileFetcher`, a URLSession with its own 500 MB cache in Caches, served from
  the cache whatever their age, which leaves a host alone for as long as a 429
  asks. Natural Earth's levels 3 to 5 are kept for good instead (`KeptTiles`, in
  Application Support), since the whole pyramid is 17 MB: a place seen once
  shows offline, whatever the system purges. The base map and the terrain are the Map panel's, kept between launches.
- Terrain (`Terrain.swift`) is Re:Earth's quantized mesh, decoded and kept per
  terrain tile; a surface tile's grid is laid over the terrain tile log₂(screen
  scale) levels coarser, the level the web app would ask for, so the app asks
  Re:Earth no more than the web app does. ADR 0009 has why. The texture budget
  is soft, as is the terrain's: a low, oblique view can use more tiles than it,
  and evicting tiles in use only starts the refinement over, or decodes them
  again and again. iOS's memory warning drops what the last frame does not use
  (`GlobeRenderer.trimMemory`), about 175 MB after the sky view.
- About, the menu column's last entry, is the web app's About dialog (`AboutView.swift`):
  what Satvis is, what it does and where its data comes from, written for the app,
  in the about page's order and with its Lucide icons, the app's links and switch
  where the web has its credits. Its demos are the Bookmarks sheet's, with their
  pictures, in a carousel as on the about page; choosing one opens it as its card does.
- The credits are one screen, About's Acknowledgements (`AcknowledgementsView`):
  what the map is drawn from now (`Credit.map`), the web app's credit display;
  where the satellites come from; the data the app fetches; and the code it
  carries, under its licences. Only OpenStreetMap wants its name in sight of the
  map (the OpenStreetMap Foundation's attribution guidelines, for the ODbL), and
  of the maps only the terrain uses its data, the VersaTiles imagery being
  photography: while the terrain is drawn, "© OpenStreetMap"
  stands left of the clock deck from when that starts, opens the
  Acknowledgements, and fades after five seconds, as the guidelines allow when
  an About entry still leads to it. The terrain's sources are copied from
  Re:Earth's `layer.json`, which CesiumJS reads at run time; check them against
  it when the terrain changes. The licences the app owes are M6's.
- The star maps are the web app's `DeepStar1K` and `DeepStar2K`, the Map panel's
  choice, fetched from the site (`data/starmap/`) and kept like the GP data, not
  shipped: they are generated with Docker by `pnpm update-starmap`, and committing
  them here would be a second copy. The sky is black until the first fetch. The
  2K map is fetched only once chosen, and the 1K one stays drawn until it has
  arrived (`StarMap`); one that cannot be had falls back to the 1K one, in the
  Map panel and in links, as the web app's falls back to its default. Its cube texture, mipmapped, is 129 MiB of GPU memory
  where the 1K one's is 32. The choice is kept between launches and in links as
  `stars`, in the web app's whole vocabulary: `Tycho1K`, its default, which
  ships with CesiumJS, is drawn as `DeepStar1K` and written back as it came.
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
  saved 4. For the same reason, past 1,000 satellites a near-circular orbit's
  line steps over 2 or 4 samples while each chord stays within a device pixel
  of the arc (`lineStride`): the GPU's cost followed the vertices it tiled, not
  the pixels, and every active orbit went from 36 to 43 frames a second.
  The ground tracks are drawn once a second into the ground overlay, a cube map
  around the Earth's centre that the globe samples by direction, so they will
  follow terrain; `RendererTests` holds its faces to Metal's own cube lookup. The
  globe samples it only while it holds a track (`GroundOverlay.hasCoverage`):
  sampled empty, it cost an iPad mini 1.4 ms of GPU a frame. The
  sensor cones are drawn per frame from the same interpolation, cut where they
  meet the ground. Both are for low orbits only, as on the web.
- 3D models are the web app's files, fetched from the site's `/data/models/` by
  the `model` a record carries (`SatelliteModel`, else its `modelFile`) and cached
  as the tiles are. The model's copies are drawn while it is small and not
  tracked, chosen by `ModelLevel`, which the parity fixtures hold to the web
  app's (ADR 0007). `ModelAsset`
  reads only what `data/models` uses (triangles, Draco, base colours, PNG, JPEG
  and WebP textures); Draco is DracoSwift's prebuilt 1.5.7 behind `DracoBridge`.
  Sizes, the point and label around a model and the close-up tracking follow
  `SatelliteComponentCollection.ts`; the lighting is a simple sun, not Cesium's
  PBR. `ios/scripts/make-model-fixture.mjs` writes the test's cube. The info
  panel's Spacecraft tab shows the model on its own (`ModelCloseUp`), as the web
  app's `ModelCloseUp.ts` does, with the globe's model shaders rather than
  RealityKit or SceneKit (ADR 0009), lit from over the viewer's shoulder at the
  web app's intensity of 2.5 and tonemapped in the shader, as it draws to the screen.
- `Session`, owned by `SatvisApp`, is one open globe: the models (`ViewerClock`,
  `CatalogModel`, `PassModel`, `SatelliteLayer`, `StarMap`, and `PassAlerts`, which
  the background refresh needs too), what is selected, followed and stood on and
  what a tap does (`Focus`, in SatvisCore, which says what the camera has to do),
  and the work that keeps them in step. It sets the globe up through
  `GlobeBinding`, in SatvisRender, which keeps what it was given and replays it
  to a renderer that arrives late, once its shaders compile. It watches the
  models with `Observations` rather than taking callbacks, so anything can watch
  them too.
  The views read it and call it and hold nothing else but what is on screen, so
  that what opens the app with a state of its own (a link, a restored scene) sets
  it in one place. Passes are predicted on demand, once a second, by `PassStore`:
  for the selected satellite, and for every active one while a station is
  selected or the ground station links are drawn. Each prediction holds for a day
  either side of when it was made, as on the web.
- A link is the view, as on the web (ADR 0001): `LinkCodec` reads one onto its
  preset's defaults, `SceneState` turns that into the app's terms and back, and
  `Session.open` applies it, replacing what is shown; `Session.link` writes the
  view back. Parameters the app does not honour (`surface`,
  `msaa`…) are kept as they came and written into every link it makes.
  The view is kept as a link when the app goes to the background and reopened
  from it, without its time, so the app reopens live. Past a component's budget
  (labels at 200 active satellites, ground station links at 500, 3D models at 200
  that have one) it switches off once, on the crossing, unless the link being
  opened names it (`ComponentBudgets`), and a link then names it whenever it is
  on, as on the web (ADR 0001). Labels past 200 are still not drawn, even
  switched on: their atlas would outgrow a texture. A link's ground stations
  visit: they are shown and predicted for, but saved only on the user's word, and
  have no alerts until then. A shared link carries the visiting stations and the
  selected one, never the rest of the saved ones, which are often where the user
  lives. Sharing is the Bookmarks sheet's: its Share button shares the view on
  screen and a card's Share its bookmark. The link is made when tapped, so a
  pinned clock gives its minute then, and handed to the system's share sheet as
  itself, which shows the site's own preview. The top-right corner is the web
  app's `#toolbarRight`, with the same buttons and labels: Home view or, in the
  sky view, Leave the sky view, then Aim by compass and the camera in the sky
  view, or Stop tracking while something is followed. Hide UI is the Graphics
  panel's first row, as on the web; while the UI is hidden the corner holds Show
  UI alone. The web offers the compass only where
  the browser has device orientation; the camera is the app's alone (ADR 0013).
  On an iPad, as on the web, the column hides under the info card, which has its
  own Track and Close; an iPhone's info sheet leaves it in place.
  satvis.space links open the app as universal links: the site's
  `public/.well-known/apple-app-site-association` claims `/ot` and `/` with a
  query, and `satvis.entitlements` the `applinks:satvis.space` domain, which
  needs the Associated Domains capability on the App ID. The simulator builds
  here are unsigned and carry no entitlements, so a universal link needs a signed
  build on a device; `SATVIS_LINK` goes through the same `Session.open`.
- The sky view (ADR 0003) is the same renderer from the ground: `SkyCamera`
  stands 2 m over the terrain at the observer, its attitude a quaternion in the
  observer's east-north-up frame, so the zenith is an aim like any other. It
  stands on the Map panel's terrain, as on the web: on the ellipsoid with None
  (ADR 0009). Entering it from a panel turns the terrain on; a link keeps its own. `SkyFlight` is the
  web's three-leg flight in and out; the instruments (`SkyHUD`) and the gestures
  wait for it to land, and reduced motion cuts. The crosshair, the tapes, the
  trace and the card read the renderer's last frame (`DrawnFrame`,
  `SkyTargets.swift`). From the ground a tap opens what it lands on, as on the
  globe, and the card opens the lock; a tap on empty sky keeps what is open
  (ADR 0003). The lock places only the satellites near the crosshair, by
  each one's direction kept for a second of the clock: placing all 16,755 active
  ones cost an iPad mini 8.6 ms of the main thread, 15 times a second (14
  measured), and with them a Debug build managed 5 frames a second. A clock fast
  enough to outrun a second between locks searches them all, as before.
  The lock's card is the web app's, two lines on every device: the name and a
  chip saying whether it could be seen, then where to look and how far. Its
  numbers are whole and grouped as en-US whatever the region, unlike every
  other number and date, which follow it (`Formats`, ADR 0015); it is held to
  `skyCard.ts` by the parity fixtures (`SkyCard`). Its width is
  fixed, scaled with the text, so it holds still as the crosshair moves from one
  satellite to the next.
  Compass aiming (`SkyCompass`) is CoreMotion's attitude against true north, or
  magnetic north without a location, so it needs no calibration step; it can
  only be tried on a device, the simulator having no motion sensor. The
  observer is where the device is, kept as the one saved station named
  "Geolocation" and moved there each time, as on the web (ADR 0003): the Sky
  panel's My location stands there, as does a link to the sky view that names no
  station. The panel's other rows are the other stations, each standing there,
  and Back to the globe while the view is up; the Globe panel then lists Sky view,
  ticked and greyed. It is listed first, by both panels' My location alike, as
  on the web, where a link's stations are its list and its sky view stands on
  the first; the app also writes the observer first into the links it makes. A link that names one stands on
  its first, and a station's panel on that station. Its own pin is hidden
  underfoot. What cannot be seen
  (ADR 0010) is dimmed or hidden by the point and label shaders, from the frame's
  sun and how dark the observer's sky is (`SkyJudgement`): per satellite on the
  CPU it would cost what the lock costs, every frame. A dimmed 3D model is drawn
  blended whole; the card's verdict is the same `Visibility`, in double precision.
  The camera's picture can show behind it (ADR 0013, `SkyPassthrough`): a preview
  layer under the globe's view, which turns non-opaque and clears where the scene
  leaves the sky, drawing the terrain in depth alone; the renderer takes the
  camera's field of view from its `CameraLens` every frame, a pinch zooms the
  camera and never takes the aim back, and the compass aims it, so whatever stops
  the compass stops the camera (`SkyAim.watchAiming`). The sky view warns while
  it stands more than 5 km from the device, but not for a clock away from now.
  The simulator has no camera: check it on a device.
- The globe's gestures are SwiftUI's, not UIKit recognizers on the MTKView, so the
  controls laid over it take the touches that land on them. They go to the
  renderer, which steers whichever camera its `CameraMode` says is in use: the free
  one over the globe, or one following a satellite or a station. A camera ignores
  a gesture that is not finite: once two fingertips meet, RotateGesture reports
  NaN, and a NaN heading drew a black globe until relaunch (TestFlight build 15).
  A camera that is not finite anyway is put back home and logged as a fault.
- 2D is the web app's flat map (ADR 0009), the Globe panel's 3D | 2D and a
  link's `scene=2D`: CesiumJS's SCENE2D in its geographic projection, drawn from
  `MapCamera` (centre, span across the view's longer side, heading). The rig keeps
  it beside the globe camera; a switch keeps the place, from the globe's centre at
  its scale, or the web app's opening view (five radii across, 287°) from where
  the whole disc shows, and back. The map repeats east and west and zooms out to
  its whole width across the view, no further, so a point
  is drawn once, at the copy nearest the centre (`MapCamera.maximumSpan`). Each
  pass has a 2D vertex function in `Shaders/Map.msl`, so 3D's are untouched, and
  the map's own draws are `MapPass`'s:
  positions are metres of the map from the view's centre, a satellite placed by
  Bowring's geodetic latitude as Cesium's 2D places it (`geodeticPosition` on the
  CPU, `mapPosition` in the shaders, which taps and placed stations go back
  through, `DrawnFrame`). Tiles are the globe's, laid flat by their texture
  coordinates and refined by metres per pixel, without terrain; a line's segments
  are quads of their own, so none stretches across the map at the antimeridian.
  The orbit there is Cesium's path, where the satellite is at each instant, not
  the inertial ring of 3D: on the map that ring left the satellite's own path. No
  stars, atmosphere or sensor cones, as on the web. Tracking holds what it follows
  in the middle at a scale of its own, which a switch of projection carries over
  from the tracking camera's range and back; a drag does nothing. The sky view is drawn in 3D and goes back to
  the map. A change of projection draws one frame more of the old one, keeps it,
  and fades it out over the new for 0.35 s (`ProjectionFade`), so it covers
  the landing out of the sky view too.
- A frame the GPU fails is logged (category `gpu`) and reported once per
  `MTLCommandBufferError` code as a PostHog exception (`GlobeRenderer.onGPUFault`):
  after one, iOS refuses the app's later frames and files no crash report.
- Ground stations are kept in `UserDefaults` on the device and synced nowhere:
  iCloud key-value sync was dropped, as it brought little and cost a section of
  the privacy policy. A station has an id, and everything that refers to one
  holds the id, not its place in the list or its name: the open panel, the
  renderer's marker (`station|<id>`), each pass, and an alert, which is dropped
  with its station.
- Every element set reaches SGP4 as OMM keywords (`MeanElements`). The worker's
  pseudo element sets still arrive as TLE lines; they are read into the same
  keywords at parse time, and Vallado's `twoline2rv` is never called.
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
- The menu column is the web app's (`Satvis.vue`'s `menuItems`): a Menu toggle
  over Bookmarks, Satellites, Components, Map, Locations, Globe, Sky and Graphics,
  then About, with their
  Lucide icons, names and order, and their hover hints, trimmed to what the
  app has, as VoiceOver hints, one panel (`PanelStyle.swift`, drawn rather than
  Liquid Glass, whose blur cost the compositor 5 ms of GPU a frame)
  whose rows each hold an icon and its name, folded on a phone and open on an
  iPad, as the web's is on a desktop. Components, Map, Locations, Globe, Sky
  and Graphics open the web's panels beside it (`ToolPanels.swift`): a title and a
  close button over a rule level with the column's, sections under small titles,
  their rows on inset cards (`PanelCard`) and led by iOS's selection circle, a
  switch and a choice alike, as the web app gives its checkboxes and radio
  buttons one left-aligned mark (`CircleToggleStyle` keeps a switch a switch to
  VoiceOver); a segmented control where the choices are short; a setting that
  needs the sky view is disabled on the globe, not hidden. On a phone the column
  folds to its icons beside a panel, as the web's does below 640 px: every panel
  is a card that stops short of the top-right buttons, which stay in view. Those buttons
  are the ways back alone: home or out of the sky view, the compass and the
  camera, and the end of tracking. Not system
  menus: iOS 26 grows one out of its control, in the column's place, and it holds
  ticked lists alone. Bookmarks and Satellites are sheets: long lists. Locations
  (`LocationsPanel`) is a panel, as both ways out of it are on the globe: its few
  stations are edited in place on a card, each removed by its cross and dragged
  by its grip, which VoiceOver moves a place at a time; picking a spot closes it,
  and a cancelled pick opens it again.
  A tap on the globe closes the panel and on a phone folds the column, as on
  the web, and a miss that did so keeps the selection.
  What the app does not draw is left out: Map's overlays, surface and Tycho star map;
  Globe's Columbus projection; Sky's keyboard note; Graphics' scene
  effects and MSAA.
- Bookmarks are the web app's (ADR 0011, `BookmarksView.swift`): the same records,
  a preset's path and the parameters the web app's stores own, so the code that
  describes and names them (`Bookmarks` in SatvisCore) is held to its
  `bookmarks.ts` by the parity fixtures, and the demos and the owned parameters
  come from `web-tables.json`. A bookmark opens through `Session.open`, carrying the
  link's other parameters, and goes live without a `time`. Saved ones and opened
  links are kept in Application Support (`BookmarkStorage`), in backups, and synced
  nowhere; a deleted one's picture stays while its own Undo lasts. A card's
  actions are a long press, and a "…" on the card shows they are there: Share on
  every card, a demo's included. Its tabs are drawn as a segmented control is,
  not the system's, which takes a segment's text alone: they carry the web app's
  counts as badges. An opened link is one the system hands over, or
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
- The Graphics panel's "FPS" is the web app's FPS switch, kept in links as
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
- The Graphics panel's "Pixel ratio" is the web app's (`pixelratio`, kept in links):
  the globe drawn at 1 or 1.5 pixels a point instead of the screen's own, which
  the system scales up (`ScaledMTKView` in `GlobeView.swift`). The renderer sizes
  everything placed on the screen in points times the drawable's pixels a point,
  labels included, so only the sharpness changes; the map refines a level less, as
  its error is measured in the drawable's pixels. On an iPad mini, before the
  shaders took fast math, the default view took 10.5 ms of GPU a frame at native,
  6.7 at 1.5 and 2.8 at 1. A benchmark runs
  at the ratio it began at and records it.
- The Graphics panel's "Frame rate" caps the globe at 30 or 60 frames a second,
  or Max, the screen's own (`preferredFramesPerSecond`, 120 asked): 120 on a
  ProMotion screen, which an iPhone gives an app only with
  `CADisableMinimumFrameDurationOnPhone` in `Info.plist` (without `OnPhone`
  it is ignored, and held 120 to 60). The simulator reports 60
  whatever it models. The web app keeps its rate in links as `framerate`; the app
  keeps its own in `UserDefaults`, as the device's choice, and ignores the
  parameter. A benchmark records it as `app_frame_rate`. That
  rate is a cap: a frame is skipped, and the last one left on screen, while
  nothing has been set or loaded, the camera stands still and no satellite can
  have moved half a device pixel, as the web app paces CesiumJS's render on
  demand (`RenderPacing`; the default view draws 4 frames a second). Whatever
  changes what is drawn has to say so (`needsDraw`, or the surface's, the models'
  and the ground tracks' revisions). The sky view, tracking, the FPS
  switch and the benchmark draw every frame, but for the benchmark's idle
  scenes. While the frames fall behind, a frame begins only once a drawable is
  free (`DrawableGate`): MTKView's `currentDrawable` blocked the main thread
  20 ms a frame with every active orbit. A `CAMetalDisplayLink` dropped 2 % of
  the sky view's frames, called after SwiftUI's redraw of its instruments. A
  frame is drawn for the instant it will be shown (`FramePresentation`): the
  clock and the flights, not a drag. Every active orbit on an iPad mini, shown
  16.7 or 33.3 ms apart, then moves by the screen's steps in 99 % of the
  frames rather than 30 %. The rate stays the one chosen, not a steady divisor
  below it: at 45 fps the eye trails a satellite 12.6 ms on average, at 30
  16.7.
- The Graphics panel's "Benchmark" is the web app's `bench=true`, kept in links
  the same way (`Benchmark.swift`, `BenchmarkPanel.swift`): eleven scenes opened
  by their links in turn, each waited for until everything active is drawn
  (`SatelliteLayer.draws`: a satellite SGP4 refuses, long decayed, is never drawn,
  so the count drawn alone never reached the count active and every active
  satellite waited out the timeout), settled 3 s and recorded 5 s frame by frame
  (`FrameRecording`), then the first again for drift, and the view put back;
  `BenchmarkReport` builds the event sent. The two idle scenes
  (`BenchmarkScene.idle`) are paced: their `fps` is the frames drawn and none
  counts as slow; their load is what they cost. `cpu_busy_pct` counts the calls
  that drew nothing too; `process_cpu_pct` is every thread's, SwiftUI's
  included, which the sky view's instruments spend more of than its renderer.
  `gpu_memory_mb` sits inside `memory_mb`, and both carry what earlier scenes
  left cached. A frame is slow past one and a half of the chosen rate's
  interval. A frame's GPU span includes other work the GPU does meanwhile, such
  as SwiftUI drawing the sky view's instruments.
  `cpu_ms` is the renderer's own work; `buffer_wait_ms` is the main thread
  blocked on a buffer the GPU still holds, the GPU running behind, and
  `drawable_wait_ms` on a drawable from the display, which, counted as CPU, read
  16 ms a frame on an iPad mini where Time Profiler found 1. A run counts no
  page views. "Send
  results" sends one `benchmark` event, only where usage is shared, its
  properties flat for PostHog's insights: `benchmark_` and `app_` for the run,
  `device_` for the device, system and screen, and `scene_<scene>_<metric>` per
  scene (`_repeat` for the drift check). Bump `Benchmark.version` when the scenes
  or the metrics change. `SATVIS_BENCHMARK` in the
  launch environment runs it at once, sends the results itself and prints them
  as JSON, for a device driven from the Mac; `SATVIS_BENCHMARK=print` only
  prints them, and `SATVIS_BENCHMARK_SCENES` (scene ids by commas) runs only
  those:
  `xcrun devicectl device process launch --console --environment-variables
  '{"SATVIS_BENCHMARK":"1"}' org.frcy.app.satvis`.
- Analytics (`Analytics.swift`) is posthog-ios, set up from the app delegate as
  its guide has it, reporting to the web app's project (ADR 0009): a `$pageview`
  of the view's link whenever the view changes, the clock aside (toggling the FPS
  switch or the benchmark panel counts, as it does on the web), its ground
  stations cut to the whole degree as the web's `posthogPrivacy.ts` does
  (`sanitizedForAnalytics`, held to it by the parity fixtures). It reports only
  from a release build on satvis.space with PostHog's project key and host, which
  are not committed: `Config/Base.xcconfig` includes them from the gitignored
  `Config/Analytics.xcconfig` (copy `Analytics.example.xcconfig`), and Xcode
  Cloud's `ci_scripts/ci_post_clone.sh` writes that file from the workflow's
  `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST`. So development, the UI tests, a
  local worker and a checkout without the file count nothing; check a change with a Release build in the simulator,
  whose events carry `$is_emulator`. "Share usage data", beside the privacy policy in About, opts
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
