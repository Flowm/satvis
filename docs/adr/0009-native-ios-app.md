---
status: accepted
---

# A native iOS app, drawn with our own Metal renderer

The iOS app is a SwiftUI shell around one `WKWebView` that loads satvis.space. Its
only native feature is scheduling pass notifications. Everything a user touches is
the web page, so it looks and behaves like a web page in a frame.

## Decision

**The native app replaces the WebView app in place.** It keeps the bundle id
`org.frcy.app.satvis` and the App Store listing, so current users get it as an
update. The last WebView commit is tagged; a hotfix to it branches from that tag.
A second target beside the WebView app was rejected: to install both on one device
it needs its own bundle id, scheme and Xcode Cloud workflow, and all that protects
245 lines of Swift.

**It offers the same core features as the web app, without a web view.** iPhone and
iPad, iOS 26 and later, SwiftUI throughout. It reads the same worker endpoints as
the web app.

**The globe is our own Metal renderer.** It must draw from an eye height of 2 m
above terrain out past GEO, against a star background:

- Positions are relative to the eye (Cesium's high/low split). Float32 resolves
  about 0.5 m at the Earth's radius, which jitters visibly near the ground.
- Depth is reversed-Z in a float buffer with no far plane, so that a 1 m near
  plane and stars at infinity share one depth buffer. It does what a logarithmic
  depth would, without writing depth from the fragment shader.
- Satellites are instanced points. Orbits are screen-space polylines. Labels are
  rendered once per name with CoreText and drawn as billboards.
- The atmosphere is Cesium's ground and sky atmosphere, ported from GLSL to Metal.
  The ported files carry Cesium's Apache 2.0 notice, with its licence beside them.
  The sun lights the day side; the star background is satvis's own DeepStar1K sky
  box (NASA SVS Deep Star Maps 2020), fetched from satvis.space and kept on disk
  rather than copied into the repository a second time.

SwiftUI draws all the controls over the `MTKView`.

**The globe has offline imagery, streamed imagery and terrain.**

- Natural Earth's level 2 ships in the app, so the first launch works with no
  network: the web app's committed tiles, copied in by the app target, not a
  second copy. Its finer levels, 3 to 5, stream from the site as the web app's do,
  and are kept once fetched, 17 MB for the whole pyramid, so that a place seen
  once shows offline. Bundling them was rejected: the same bytes, but every
  install pays for all of them.
- VersaTiles satellite, NASA Black Marble and VIIRS stream as the user zooms. The
  surface is a quadtree of geographic tiles, as CesiumJS's, and each tile's
  texture is baked from the base map's tiles: VersaTiles's and VIIRS's Web
  Mercator ones reprojected on the way, Black Marble's (GIBS's geographic WMS, as
  the web app asks it) and Natural Earth's copied. VIIRS is GIBS's daily true
  colour: the clock's day within the days GIBS lists, as the web app's
  `GibsTimeLayer` shows it, the map baked again when the day changes. A tile still loading is stood in for by the nearest
  ancestor that has loaded, so the globe never waits on the network.
- Re:Earth terrain (quantized-mesh, geographic grid, levels 0–14, CC BY 4.0) is a
  toggle and is off by default, as on the web. The sky view turns it on, for the
  horizon and the eye height. The surface is refined by device pixels, for sharp
  imagery, but each tile takes its heights from a terrain tile log₂(screen scale)
  levels coarser: the one CesiumJS would pick, since it measures in CSS pixels.
  Asking for terrain at the surface's own level was nine times the web app's
  requests on a 3× screen, and Re:Earth, a free service, answered with 429s. A
  terrain tile that fails is stood in for by its nearest loaded ancestor, and
  tried again a minute later.

**A ground-track swath is drawn into an overlay texture.** The globe shader samples
a cube map around the Earth's centre, six faces of 2048 texels, about 5 km per
texel, so the swath follows terrain at no extra cost, and the cost does not grow
with the satellite count. A cube rather than an equirectangular texture: that
one would need its corridors split at the antimeridian and would pinch them at
the poles, which every polar orbit crosses; a cube face keeps great circles
straight. Edges get soft when zoomed in close. That is acceptable for swaths
100 km wide or more.

**Propagation reproduces the web's results.**

- SGP4 is Vallado's C++ reference code in a SwiftPM target. satellite.js is a port
  of the same code, so the two apps agree to within a metre.
- Each sampled trajectory keeps the web's grid, anchored to its element-set epoch.
  Background tasks fill its window, and the vertex shader interpolates between the
  samples every frame. No per-satellite work happens on the CPU per frame.
- The pseudo-fixed frame is the same: GMST, with UT1 taken as UTC.

**Tags and presets come from the worker.** On the web they were hard-coded in
`src/config/presets.ts`. A copy in Swift would need an App Store release for every
new plugin group. So:

- Tags are defined on each group in the YAML config.
- Presets are defined in the YAML config, with their defaults written in the URL
  parameter vocabulary (ADR 0001). Each client decodes them with its own URL codec
  and drops the values it does not know.
- `/api/groups.json` serves both. The web app reads them from there too, so the
  config exists once.
- The `ot` preset moves into the plugin that supplies its groups.

**The app works offline.** Each group is kept on disk with its ETag. The app checks
for new data on launch, on return to the foreground, and in `BGAppRefreshTask`,
which keeps pass notifications correct. No catalog ships in the app: one would be
weeks out of date for most installs and replaced by the first answer anyway, so a
first launch offline shows none until the worker answers once.

**Links are the shared state, as on the web.** The URL codec is ported. Share
produces a satvis.space link, and a universal link with state opens in the app.
`/ot` selects the OT preset; the app has no preset picker. A plain `satvis.space/`
still opens the website. Ground stations are kept on the device, and synced
nowhere: iCloud key-value sync was tried and dropped, as it added little and
another processor to the privacy policy. That makes a link's stations different
from the web's:

- A link's stations are shown with its view and saved only when the user says so,
  so that opening a link never edits the user's own list.
- A shared link carries the selected station and those a link brought, not every
  saved one, which are often where the user lives.
- The app keeps its view as a link and reopens on it, but live: a clock found
  paused hours later reads as broken.

**The sky view is the web's (ADR 0003, 0004), with three native differences.**
Compass aiming reads CoreMotion's attitude, referenced to true north where the
location is known and to magnetic north where it is not: either way a measured
heading, so the web's "hold the phone flat to set north" step has no
counterpart. The sky view stands on Re:Earth's terrain whatever the Map menu
says, because the eye's height and the horizon need it. And `scene` names only
the two views the app has, `3D` and `Sky`: a `2D` or `Columbus` link opens on
the globe and drops the parameter, as a link naming a layer the app lacks does.

**Usage is counted in the web app's PostHog project**, as PostHog advises for
one product on several platforms, told apart by `platform: ios` and PostHog's own
`$lib`. A view is a `$pageview` of its link, so the insights that count users per
url parameter count the app too. Project settings reach every platform, so the
app turns off in its own code what it must not collect, whatever the project
says: person profiles, screen and element autocapture, replay, surveys and push
capture. Only a release build on satvis.space reports, as only satvis.space does
on the web; a TestFlight build says so (`distribution`), and the user can switch
it off.

## What the native app leaves out

- Cesium World Terrain, MapTiler and ArcGIS terrain
- Surface models: OSM Buildings and Google Photorealistic (ADR 0005)
- The Columbus view mode
- The GOES-IR and Nexrad overlays, and the debug tile grid
- The OSM and ArcGIS basemaps. The OSMF tile policy forbids an app that
  depends on `tile.openstreetmap.org`, and Esri's terms for published apps were
  not worth checking for a second satellite basemap.
- MSAA and the scene effects in the Graphics menu, WebVR and the embed mode

These come later: the 2D view mode, the inertial camera mode, the DeepStar2K star
map, a camera passthrough in the sky view, and a Live Activity for a pass.

3D models are drawn from the web app's own files rather than a converted copy,
so `data/models` stays the one place a model is built. GLTFKit2, the plan here
at first, was not used: it would still have needed Draco, which every model is
compressed with, and its scene objects would have been converted again for the
Metal renderer, which needs only meshes, materials and textures. A small GLB
reader does that, with Draco from the prebuilt DracoSwift package. They are lit
by the sun alone, not by Cesium's physically based lighting: at the 20 to 72
points they are mostly drawn at, the difference does not show.

## Release

Each milestone ships to TestFlight. **The App Store release waits for the sky
view.** The update replaces the WebView app for every current user, and an
earlier release would take the sky view away from them.

| Milestone | Contents                                                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0a       | Shared config: tags and presets in YAML and in `/api/groups.json`, the web app reads them, an ETag on the index. Merged on its own.                                                                                                                               |
| M0b       | Foundation: tag and remove the WebView app, `ios/SatvisKit`, SGP4 and the parity fixtures, the data client and cache, CI.                                                                                                                                         |
| M1        | First light: the globe, satellites as points, live time.                                                                                                                                                                                                          |
| M2        | Explore: browser and search, selection, info panel, labels, orbit and orbit track, tracked satellite, clock deck.                                                                                                                                                 |
| M3        | Passes: ground stations, both overpass modes, the passes tab, notifications, the ground station link.                                                                                                                                                             |
| M4        | Map: streamed imagery, terrain, ground track, sensor cone, attribution.                                                                                                                                                                                           |
| M5        | Links: URL codec, share, universal links, `/ot`, state restoration, PostHog. The App Store screenshots of the about page's three demo views, taken natively by link (the WebView app's `testScreenshot*` tests, dropped with it).                                 |
| M6        | Sky view, aimed with CoreMotion's attitude. An acknowledgements screen with the licences and credits the app owes: CesiumJS (Apache 2.0, with its third-party notices), Vallado's SGP4, Natural Earth, and NASA SVS for the star map. Then the App Store release. |

## Code and checks

The app target contains the views, their models, and the session that holds what
is selected and ties them together. Everything else is in the local package
`ios/SatvisKit`:

- `SGP4`: the C++ code
- `SatvisCore`: parsing, the catalog, passes, the URL codec, metadata
- `SatvisData`: the worker client and its cache
- `SatvisRender`: Metal

`swift test` runs on macOS without a simulator.

**Parity fixtures** are the outputs of the web app's own code for a fixed set of
element sets: satellite.js positions, `PassPredictor` passes, `urlCodec` round
trips and `orbitFacts`. A Node script writes them. The Swift tests compare against
them: a position must agree to within 1 m, and a pass start or end to within 1 s.

A GitHub Actions job on GitHub's `xcode-27` image runs the package tests and regenerates the
fixtures. It fails if the fixtures changed, so a change to the web's propagation
cannot break parity unnoticed. It also lints the Swift sources and builds the app
and its UI tests. Xcode Cloud builds the app, runs its UI tests against a worker
that does not answer, on a fixed test catalog only Debug builds carry, and
uploads to TestFlight.

## Alternatives rejected

- **Keep the WebView and improve the shell.** Native controls around a Cesium
  canvas still leave the globe, the gestures and every panel a web page.
- **RealityKit.** It has picking, PBR and USDZ loading, but no line primitive:
  every orbit would be a ribbon mesh rebuilt each frame to face the camera. It
  also gives no control of depth precision.
- **SceneKit.** Soft-deprecated since WWDC25.
- **cesium-native.** It selects 3D Tiles and terrain tiles, but has no Metal
  backend, so the renderer would still be ours, and so would the integration.
- **MapKit's 3D globe.** It cannot place an object in space, so it cannot draw an
  orbit.
- **satellite.js in JavaScriptCore.** No web view, but still JavaScript across a
  bridge in the propagation hot path. The C++ reference gives the same results
  natively.
- **SGP4 per satellite per frame.** An estimated 4 ms a frame for 12,000 satellites on
  worker threads. Simpler than the grid, but the cost is battery, all the time.
- **Shadow-volume classification for swaths** (what Cesium does). Sharp at any
  zoom, but complex and expensive with many satellites.
- **Presets read at build time** from the generated config. Startup would not
  change, but a checkout without the private plugins would build a web app
  whose presets disagree with the production API that `pnpm dev` talks to.
- **Full parity before the first release.** No feedback until the end, for a
  rewrite of about 23,000 lines.
