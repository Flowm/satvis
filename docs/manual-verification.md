# Manual verification

Checks that `pnpm test` cannot run. jsdom has no layout engine, no GPU and no
render loop, so it cannot answer `getBoundingClientRect`, `elementFromPoint`,
stacking, frame contents or frame timing.

Each check names the code it **covers**, its **procedure**, and its latest
**result** with a date. When you change covered code, rerun the check and replace
the result. `cc` is the `CesiumController` that `src/app.ts` puts on `window`.

## Harness notes

These apply to every check driven from an automated or hidden browser pane.

- **A hidden pane gets no `requestAnimationFrame`**, so the globe and the
  satellites never build. Load the page with `?framems=16`
  (`src/modules/benchmark/README.md`).
- **A hidden pane reports a 0×0 canvas.** Take a screenshot, which fronts the pane,
  before you measure anything sized off the canvas, such as a drag's degrees per
  pixel.
- **A hidden tab clamps timers** to a second, and sometimes to minutes. Read a
  timed outcome, such as the compass probe, in a later call instead of awaiting it.
- **State re-evaluated on `preRender`** (the OSM Buildings ceiling, the sky-view
  lock) does not change until a frame runs. Call `cc.viewer.scene.render()` after
  you move the camera from the console.
- **A hidden tab does not restyle a pseudo-element** for a `checked` property set
  from script. Read `checked`, or take a screenshot.
- **Synthetic multi-touch:** `setPointerCapture` throws `NotFoundError` for a
  pointer id the browser has not seen. It throws inside `#onPointerDown`, so the
  rest of that handler does not run and a two-finger gesture becomes a one-finger
  drag. Stub `canvas.setPointerCapture` and `releasePointerCapture` to no-ops.
- **The app writes its state into the query.** A bare path revisited in the same
  tab can open on an earlier url. Navigate with a distinct query (`/ot?v=clean`).
- **An emulated viewport does not fire `resize`.** Dispatch one after each width
  change.
- **Surface models and terrain from ion** need an unrestricted
  `VITE_CESIUM_ION_TOKEN` locally (AGENTS.md, Gotchas).

## Sky view: the HUD does not swallow clicks

**Covers:** `src/components/SkyHud.vue`, the `z-index` of `#toolbarLeft` /
`#toolbarRight` (`src/css/main.css`) and `.entity-info-panel`
(`EntityInfoPanel.vue`), `ClockDeck.vue`, and `SkyInteraction` listening on the
canvas.

The HUD is a transparent full-viewport layer, so a control under it still looks
correct. `#cesiumContainer` is a sibling before `#app`, and `#app` isolates its
stacking context, so no z-index lifts Cesium's widgets above the app. The
arrangement that works: HUD root at `z-index: 4` with `pointer-events: none`,
entity info panel at 5, toolbars at 6, and look-around listening on the Cesium
canvas, not on an overlay. The HUD holds no interactive control.

**Procedure.** Open `?scene=Sky&gs=48.1400,11.5800` and wait for the scene to
settle. Select a satellite first for the panel:
`cc.viewer.selectedEntity = cc.sats.activeSatellites[0].defaultEntity`. Then hit-test
the centre of each control:

```js
[
  ["toolbar Map", "#toolbarLeft .toolbarButtons button:nth-child(4)"],
  ["toolbar eye", "#toolbarRight button"],
  ["cesium credits", ".cesium-credit-logoContainer"],
  ["clock deck controls", ".cluster"],
  ["clock deck scale row", ".scale-row"],
  ["entity info panel", ".entity-info-panel"],
].map(([name, selector]) => {
  const el = document.querySelector(selector);
  if (!el) return [name, "not present on this platform"];
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return [name, el.contains(hit) ? "clickable" : `BLOCKED by ${hit?.className || hit?.tagName}`];
});
```

**Result, 2026-07-27, Chrome, 1618x1576.** All six clickable. That run checked
Cesium's animation and timeline widgets where the two clock deck rows are now; the
deck rows have not been run through this snippet.

## Sky view: the zoom gestures

**Covers:** the wheel and pinch handlers in `src/modules/SkyInteraction.ts`, and the
`fovy` setter in `SkyView.ts` (`MIN_FOVY`, `MAX_FOVY`). The clamp and the curve are
unit-tested; event dispatch against a live canvas is not.

**Procedure.** Open `?scene=Sky&gs=48.1400,11.5800`. Dispatch `WheelEvent`s and
`PointerEvent`s at `cc.viewer.scene.canvas`, and read `cc.skyView.fovy` and
`cc.skyView.aim` between them. Two fingers 100 px apart that spread to 200 px must
halve the field of view. The aim must not change.

**Result, 2026-07-28, Chrome.** Wheel: 75° → 55.561° → 41.161° on equal notches
(a constant ratio), and −200/−200/+400 returns to exactly 75°. Clamps at 10° and
90° (the upper clamp was 90° then; `MAX_FOVY` is 100 now). A `deltaMode: 1` delta of
−3 steps 75° → 69.79°, so Firefox-style deltas work. Pinch: 60° → 30° at 2×
separation and → 20° at 3×, computed from the gesture start. The aim was identical
across every notch and the whole pinch. A drag after the second finger lifted moved
the aim without a jump.

## Sky view: the compass tape holds its scale

**Covers:** `headingOffset` in `src/composables/useSkyHud.ts` and the tape in
`SkyHud.vue`. `headingOffset` is unit-tested against a projection, including the
`1/cos(pitch)` divergence it avoids; the live tape is not.

**Procedure.** Open `?scene=Sky&gs=48.1400,11.5800`. Step
`cc.skyView.look({ pitch })` through 0, 30, 60 and 85, read the tick offsets from
the HUD, and check that the spacing between adjacent ticks does not change.

**Result, 2026-07-29, Chrome.** Spacing constant at every pitch, and the marks point
at the zenith. Before the fix, 15° of azimuth spanned 147 px at eye level and
1691 px at 85° pitch.

## Sky view: a drag takes the aim back from the compass

**Covers:** the pointer handlers and sensor subscription in `SkyInteraction.ts`
(`TAP_SLOP`, `SENSOR_PROBE_MS`, `disableDeviceOrientation`), and the compass control
in `src/composables/useSkyCompass.ts`. Decision: ADR 0004.

**Procedure.** Open `?scene=Sky&gs=48.1372,11.5756,Munich`. Dispatch a
`deviceorientationabsolute` event every 100 ms with `absolute: true` and a fixed
`alpha`/`beta`/`gamma`, then switch the compass on in the View menu. Drag on
`cc.viewer.scene.canvas` with `PointerEvent`s, and read
`cc.skyInteraction.orientationActive`, `cc.skyView.aim` and the control's `checked`
between them. Stub pointer capture and take a screenshot first (Harness notes).

**Result, 2026-08-05, Chrome.** Aiming from the fake sensor at azimuth 258.49°,
pitch −29.50°, roll −5.73°. A 5 px nudge inside the tap slop changed nothing. A
40×40 px drag turned the sensor off, levelled the roll to 0 and moved the aim to
254.64° / −25.54°, the drag's own 4.2° at that canvas height. 300 ms of further
sensor readings did not pull it back, and the control unticked itself. A drag during
the 1200 ms probe returned `taken-back`, with the sensor off, the roll level, the
control unticked and no toast.

**Pinch, 2026-08-06, Chrome.** Two fingers 100 → 200 px halved the field of view,
75° → 37.5°, with the sensor still aiming. Lifting the second finger and moving the
other 3 px left it aiming, and the gesture selected nothing. A 100 px drag of the
remaining finger then handed the aim over. Regression guarded: the pinch used to
set `#dragged = TAP_SLOP + 1` to mean "not a tap", and the handover read the same
counter, so the first pixel after a pinch ended compass aiming.

## Sky view: the movement keys walk the observer and the station follows

**Covers:** `src/modules/SkyMovement.ts` (`SETTLE_MS`), `SkyView.moveObserver` and
its ground measurement (`WALK_MEASURE_MS`), and the write to `gs` in `sceneSync.ts`.
The walk arithmetic (`SkyMovement.test.ts`) and the store side (`sceneSync.test.ts`)
are unit-tested; the chain from a key on `window` through `preRender` to the url is
not.

**Procedure.** Open `?scene=Sky&gs=48.1372,11.5756,Munich` and wait for the descent
to land. Dispatch `KeyboardEvent`s on `window` with the `code` under test, and read
`cc.skyView.observer`, `cc.skyView.eyeHeight` and `gs` between them. Timers and
frames are throttled in a hidden tab, so hold the key and call
`cc.skyInteraction.movement.step` with your own timestamps for the walk. Run
`cc.viewer.render()` on an interval to check the `preRender` path separately.

**Result, 2026-08-05, Chrome.** A held `KeyW` through real frames moved the observer
south (the default aim at a northern latitude faces the equator), 2 m per capped
step at one frame a second. On a driven clock, one second of shift-held `KeyW`
moved 176 m (160 m of sprint plus one clamped 100 ms first step). The url did not
change while keys were down. 350 ms after keyup, `gs` became
`48.1340,11.5756,Munich`: name kept, rounded to the store's precision, observer
snapped to the rounded point. `KeyE` for 3 s took the eye to 498 m, and the horizon
rose to the 0° tick. Q stops at 2 m and E at 5000 m. Leaving for 3D with `KeyW`
still down landed the exit flight and wrote nothing: an unsettled walk is dropped.
No console errors.

**Re-checked 2026-08-06, Chrome,** after the walk began to measure the ground on
the 250 ms throttle instead of `globe.getHeight`: the eye held at 2 m through the
sprint and the settle still wrote `gs`.

**Not verified:** walking under `surface=GooglePhotorealistic`, the case that fix is
for. Record `camera.positionCartographic.height` on every `preRender` while you hold
`W` in Munich. It must stay near the mesh top (~570 m), not fall to 2 m.

## Sky view: the observer is a designation, not the first station

**Covers:** `sat.observerStation` (`src/stores/sat.ts`), `resolveObserver` and the
observer watcher in `sceneSync.ts`, and `src/components/GroundStationList.vue`.
`sceneSync.test.ts` and `groundStationEdits.test.ts` cover the seams; this checks
that entry, a change of designation and a reorder agree in a live scene.

**Procedure.** Open
`?gs=48.13,11.58,Munich_47.27,11.39,Innsbruck_51.51,-0.13,London`. In the ground
station panel, press a station's rank to designate it, drag or arrow-key a row to
reorder it, and press a row's × to remove it. Also enter the sky view from a
station's info panel. Read `cc.skyView.observer`, `gs` and which row carries the ◉
between them.

**Result, 2026-08-11, Chrome (frame pump on).** Entering from London's info panel
stood the view at `{lat: 51.51, lon: -0.13}`, `gs` unchanged in order, ◉ on row 3,
info panel still open on London. Pressing rank 2 moved a live view to Innsbruck
`{lat: 47.27, lon: 11.39}`, list order unchanged. Arrow-keying Munich down past
Innsbruck carried the ◉ with Innsbruck to row 1 and did not move the observer. With
London designated, removing Munich left the ◉ on London at row 2 and the observer
unmoved. The GEO arc read Meteosat-12 at 30.3° elevation, 180.4° azimuth from
London. No console errors.

## Sky view: enabling a surface model must not lurch or flip

**Covers:** the terrain swap in `CesiumController` that measures the new provider
before it assigns it, and `SkyView`'s ground height source. Decision: ADR 0005.

**Procedure.** Enter `?scene=Sky&gs=48.1372,11.5756,Munich` with no surface model,
then enable OsmBuildings while you record `camera.position` and `camera.up` on every
`preRender`.

**Result, 2026-07-30, Chrome.** Two eye heights, 2 m then 572.8 m (World Terrain's
570.8 m plus the 2 m eye), in one transition in the frame the provider changes.
`up.z` constant at 0.979. Before the fix the eye stayed at 2 m, ~570 m under the new
ground, then stepped up per terrain refinement (one reading of −76639 was rejected
by the plausibility guard).

## Sky view: moving the observer must not drop the eye underground

**Covers:** `SkyView.enter` and the ground height source.

**Procedure.** Settle the sky view over Munich with OsmBuildings. Move the observer
with `cc.skyView.enter({ lat, lon })`, which is what a station drag or a geolocation
fix does, and record `camera.position` on every `preRender`.

**Result, 2026-07-30, Chrome.** One height throughout, 572.8 m, `up.z` constant at
0.979. Before the fix the eye went to 2 m, 568 m underground, until the measurement
returned.

From under a surface you see its underside with the same imagery: a plan view of
the city, an edge where the mesh ends, black below. It was reported as the world
flipping. Reproduce it with `cc.skyView.setGroundHeight(0)` over any city.

## Sky view: the terrain hides the satellites behind it

**Covers:** `depthTestAgainstTerrain` and `coarseDepthTestDistance` in `SkyView.ts`
(`#enter` and exit).

**Procedure.** Open
`?terrain=ReEarth&scene=Sky&elements=Point&tags=Starlink,Weather,Stations&gs=47.3879,12.3077`
(the Kitzbühel Alps). For each satellite that projects inside the viewport, compare
the brightest pixel within 4 px of its projection between a frame with
`scene.globe.depthTestAgainstTerrain` on and one with it off. A point reads 173
against terrain's 45–70. Compute each satellite's elevation against the geodetic
normal at the eye.

**Result, 2026-08-10, Chrome.** 133 satellites on screen. Depth test off: 94 drawn,
from −0.96° to 67°. On: 48 drawn, lowest at 9.28°, the ridge line in that direction.
The 46 removed spanned −0.96° to 14.26°, and none appeared that was not drawn
before.

Before the fix, Cesium's depth plane already hid the sky below the horizon (with
`scene._depthPlane.execute = () => {}`, satellites at −7° drew at full brightness).
Its cutoff is about 1° short of the horizon, because it is a quad of the limb's
radius ~101 km from an eye 800 m up. So the missing occlusion was relief only.

**Labels, 2026-10-04, Chrome.** Beyond the label collection's
`coarseDepthTestDistance` (~636 km) Cesium tests billboards against the ellipsoid
only. At `?scene=Sky&gs=46.5935,7.9091&terrain=ReEarth&time=2026-10-04T20:00Z`
(Lauterbrunnen, looking south), 5 of 72 weather-satellite labels (METEOSAT-9,
CYGFM07, CYGFM02, FENGYUN 3F, ELEKTRO-L 2) drew on the cliffs with no point. With
`SkyView` setting the distance to infinity, all five went and the five above the
skyline stayed. Leaving the view restored 635,675 m.

## Sky view: the crosshair agrees with the picture

**Covers:** `groundHides` (`src/modules/SkyTargets.ts`) and the lock in
`SkyInteraction.ts`. `SkyTargets.test.ts` covers the ordering and the lock; this
checks the answer against the frame.

**Procedure.** Same place and terrain as above.

1. For each satellite above the horizon in the viewport, compare `groundHides` with
   whether the frame drew it (brightest pixel within 4 px).
2. Aim at each of 25 satellites in turn, render **twice**, and compare
   `cc.skyInteraction.locked` with the pixel at screen centre. The lock runs in
   `preRender` against the tiles of the previous frame, so the first frame after a
   jump answers for the old view. A drag never shows this.

**Result, 2026-08-10, Chrome, 11,011 satellites.** Part 1: 87 of 88 agreed. The
exception sat at 9.7° on a ridge silhouette, where the ray meets a tile the drawn
mesh dips below. Part 2: 25 of 25 (8 drawn and locked, 17 hidden and not locked).

Cost, warm: about 10 µs a ray. 25 samples took 0.23–0.31 ms per batch, on the
500 ms sampling interval. Frame time stayed at 11.5–14.4 ms with no spike on a
sampling frame. Cold, the first rays of a session took up to 2 ms.

## Sky view: what a device is still needed for

**Covers:** `src/modules/DeviceAim.ts` and the sensor path in `SkyInteraction.ts`.

Device orientation is **verified on iOS**: the sign of the screen-orientation
correction and the `360 - webkitCompassHeading` substitution are right, and the sky
lines up with no trim. **Not verified:** the Android path,
`deviceorientationabsolute` (ADR 0004). `DeviceOrientationEvent.requestPermission`
and `getUserMedia` need a secure context, so `pnpm dev:host` over a LAN address
cannot test them. Use a tunnel or a preview deploy. Camera passthrough is not
implemented.

## Entity info panel: the tab set, the timeline and the pass link

**Covers:** `src/components/EntityInfoPanel.vue` (`activeTab`, the fold, the
telescope button). `passTimeline.test.ts`, `orbitFacts.test.ts` and
`PassPredictor.test.ts` cover the layout, the facts and the formatting.

**Procedure.** Open `?sats=ISS%20(ZARYA)&gs=48.13,11.58,Munich_47.27,11.39,Innsbruck`.
On the satellite, click a block on the strip and read which row is highlighted,
switch to `Details`, then select a ground station and read the active tab. On the
station, press the telescope button and read `gs`, `cc.skyView.observer` and
whether the panel is still open. On a phone viewport, press the active tab to fold
the body.

**Result, 2026-08-12, Chrome (frame pump on).** The fourth block highlighted the
`Munich 8 h 19 m 07:41:48` row and the clock kept running. `Details`, then Innsbruck,
reset the tab to `Passes` instead of an empty body, with the tab list hidden (a
station has one tab) and no timeline (511 passes is too many). The telescope stood
the sky view at `{lat: 47.27, lon: 11.39}`, `gs` unchanged, panel still open on
Innsbruck. No console errors.

**Fold, 2026-08-20, Chrome, 390x844.** The fold lives in `activeTab`'s setter,
because Reka's tab trigger sets the model on every press. Panel 491 px open, 145 px
folded (header, position strip, tab row). The active tab folds and unfolds
repeatedly; the other tab switches and expands in one press. Folded, 556 px of globe
lies between panel and deck, and a pass ten minutes ahead draws 29 px wide at 220 px
along a 390 px ruler.

## Entity info panel: once a second at any clock speed

**Covers:** `src/modules/util/CesiumCallbackHelper.ts` and
`src/composables/useSelectedEntity.ts`. The helper's timing is unit-tested.

**Procedure.** Open with `?framems=16` and select a LEO satellite with
`cc.viewer.selectedEntity`. For 5 s at each clock speed, count the frames on which
the panel's `innerText` changed. Pause, jump the clock 30 min, and check that the
panel catches up and then stays still.

**Result, 2026-10-04, Chrome (frame pump on), CYGFM04.** 5 changes at 1×, 60×,
3600× and 86400×, none while paused (before: 310 in 311 frames at 3600×). After the
jump the panel updated within 200 ms and then did not change.

## Surface models: the matrix, the eye height, and what drapes on a mesh

**Covers:** `surfaceEffects` and `viewModeNote` (`src/config/surfaceModels.ts`,
unit-tested), `src/modules/SurfaceModel.ts`, the terrain note in
`src/components/Satvis.vue`, and the ground station pin. Decision: ADR 0005. Needs
an unrestricted `VITE_CESIUM_ION_TOKEN`.

**Procedure.** With `?layers=ArcGis&gs=48.1372,11.5756,Munich`, walk `surface=` and
`scene=` through the combinations. Read `cc.surface.active`, `scene.globe.show`,
`scene.terrainProvider.constructor.name`, the camera's cartographic height, and the
dimmed groups in the Map panel.

**Result, 2026-07-29, Chrome** (terrain radio re-checked 2026-07-30).

- `surface=OsmBuildings&scene=3D`: buildings on the globe, terrain
  `CesiumTerrainProvider` while the store holds `None`, Terrain dimmed and Layers
  not. The radio reads `CesiumWorldTerrain` with its rows disabled, and the note
  reads "OsmBuildings needs CesiumWorldTerrain, None returns".
- `surface=GooglePhotorealistic&scene=Sky`: globe hidden, mesh drawn, Layers and
  Terrain dimmed. Camera at 563.3 m: the mesh surface plus 2 m.
- Then `scene=3D`: tileset removed, globe back, nothing dimmed, terrain
  `EllipsoidTerrainProvider`, `?surface=` kept, note "Applies in the sky view only".
- `surface=OsmBuildings&scene=2D`: no tileset, terrain not overridden, note
  "Applies in the 3D and sky views only".
- A probe corridor with `heightReference: CLAMP_TO_GROUND` draped onto the
  photorealistic mesh, following the street and occluded by buildings. The ground
  track needs no suppression there.
- With `VITE_CESIUM_ION_TOKEN=not-a-real-token`, selecting `GooglePhotorealistic`
  toasted "GooglePhotorealistic unavailable … Cesium ion needs a token valid for
  this origin", reset the radio to `None` and dropped `surface` from the url.
  `SurfaceModel.apply` ran twice (attempt and revert), so the failure is reported
  once.
- At the Eiger with `terrain=CesiumWorldTerrain` the station pin sits on the ridge
  (at height 0 it was ~4 km under it).

**Loading cost, 2026-07-30, Chrome.** At globe altitude OSM Buildings loads nothing
(0 tiles, 0 MB). In the sky view at Marienplatz, settled: 34.38 MB across 34 tiles
with the sky-view roll-off, 39.73 MB across 40 at Cesium's defaults (13% less). Eye
at 573 m. These numbers were taken against a 2 km globe ceiling: at 9,261 km and
2,500 m the tileset was hidden (0 tiles, 0 MB), and at 1,400 m it showed and
streamed 35 tiles, 44 MB. The ceiling is now 1 km above the ground
(`GLOBE_BUILDING_CEILING`), and the above-ground gate is **not verified**: this
environment never refined terrain past level 0, so `globe.getHeight` returned
nothing or nonsense (−76594). Re-check in a real browser over a high city.

**The mesh waits for the descent, 2026-07-30, Chrome.** Entering the sky view with
`surface=GooglePhotorealistic`: mid-flight the tileset had `show: false`, 0 MB, and
the globe visible. On landing (`settled: true`) it showed, the globe hid, and
requests started. Tileset options: `maximumScreenSpaceError: 24`,
`skipLevelOfDetail: true`, `immediatelyLoadDesiredLevelOfDetail: true`.

**Not measured:** the skip-LOD saving (it needs an uncached city and Google quota),
and iOS, where the reduced `cacheBytes` apply. The service worker is checked in the
build output: neither `ion.cesium.com` nor `googleapis` appears in `dist/sw.js`.

## Map menu: the Basemap/Overlays split, and Re:Earth terrain

**Covers:** the imagery and terrain registries in
`src/modules/CesiumLayerProviders.ts` (`base`), `setLayers` in
`src/stores/cesium.ts`, and the Map menu.

**Procedure.** Open `?layers=ArcGis_0.5,Nextrad&terrain=ReEarth`. Read the two
imagery groups, switch basemap, toggle an overlay, and fly somewhere with relief.

**Result, 2026-07-30, Chrome.** Basemap radios had ArcGis checked, bound by
provider, so the `_0.5` token still reads as ArcGis. (The radios then also listed
`Offline` and `OfflineHighres`; both are now the single `NaturalEarth`.) Overlays
`Tiles`, `GOES-IR`, `Nextrad`, with Nextrad checked. Switching to OSM wrote
`?layers=OSM,Nextrad`, keeping the overlay and dropping the old basemap's opacity.
Toggling `Tiles` gave `OSM,Nextrad,Tiles` and three imagery layers; untoggling gave
two.

Re:Earth terrain resolved `https://terrain.reearth.land/cesium-mesh/ellipsoid/` and
rendered the Bernese Alps with relief. Its credit "Re:Earth Terrain · Mapterhorn
(CC BY 4.0)" shows in the attribution, beside the service's own layer.json credits.
Re:Earth is a free, keyless service with no SLA: if terrain looks flat, check it
first.

VersaTiles rendered the right way up (its TileJSON declares no `scheme`, so no
`{reverseY}`) and sharp orthophoto over central Munich, tile levels 7 to 14, no
errors. "VersaTiles sources" is in the attribution.

## Layers: the base map's depth upgrade

**Covers:** `__IMAGERY_MAX_LEVEL__` (`vite.config.ts`), the `NaturalEarth` provider
in `CesiumLayerProviders.ts`, and the imagery precache globs.

**Procedure.** Use a checkout without `data/imagery/NaturalEarthII/3/`, which is any
checkout where nobody ran `pnpm update-imagery`. Load the default route, read the
basemap selection, the url and the console, and zoom past continent scale. Then run
`pnpm update-imagery`, restart (the ceiling is a build-time `define`), and zoom
again. Do not simulate the absent case by deleting files from a running dev server:
that most likely answers 404, where a file that never existed gets the SPA fallback
(inferred, not measured).

**Result, 2026-08-04, Chrome, dev and built preview.** Basemap `NaturalEarth` both
times, url unchanged, console clean, a correct globe either way: `maximumLevel` 2
without the generated levels and 5 with them. Only the ceiling changes, never the
selection. The design this replaced switched the selection to a fallback provider
when imagery was missing, and its probe, answering after the route preset had
hydrated, overwrote the preset's basemap. That is why nothing may correct the layer
stack after hydration (`startSceneSync` in `src/modules/sceneSync.ts`).

Above the ceiling the map is complete: built with levels 4–5 removed and the
ceiling at 5, the Alps and Italy rendered from magnified level-3 imagery, with seams
where neighbouring tiles magnify by different amounts. Offline, a region the runtime
cache never held takes the same path, which is why the precache goes to level 3.

**Measured:** in the built preview, a ranged request for a missing tile returns
**206 with `content-type: text/html`**, and a plain request for a missing manifest
returns **200 with `index.html`** (1065 bytes). `response.ok` is true for both. An
earlier result in this file (2026-07-28) was wrong because its probe trusted the
status (AGENTS.md, "Probes read the answer, not the status").

## Worker: missing files 404, and none of it is billed

**Covers:** `not_found_handling` in `worker/wrangler.jsonc`, `public/404.html`,
`public/_redirects`, and the Worker's `fetch`. Constraint: asset traffic must not
become billed Worker invocations.

**Procedure.** `pnpm build`, `pnpm dev:worker`, then request each path and read the
status. For billing, put `console.log("BILLED", new URL(request.url).pathname)` at the
top of the Worker's `fetch` and watch which requests log.

**Result, 2026-07-30, wrangler dev on the built dist.**

| path                                     | status                                                     |
| ---------------------------------------- | ---------------------------------------------------------- |
| `/`, `/ot`                               | 200 text/html                                              |
| `/embedded.html`, `/test.html`           | 307 to `/embedded`, `/test` (asset router `html_handling`) |
| `/typo-route`                            | 404 text/html (the 404 page)                               |
| `/api/groups.json`                       | 200 application/json                                       |
| `/cesium/…/tilemapresource.xml` (exists) | 200 application/xml                                        |
| `/data/imagery/…` (a missing tile)       | **404**                                                    |
| `/data/gp/weather.json` (absent)         | **404**                                                    |

Only `/api/groups.json` logged `BILLED`. Two configurations that do invoke the
Worker, both measured: `404-page` with no `404.html`, and
`not_found_handling: "none"` for every unmatched path. Production before the change
answered a missing data asset with `200 text/html`.

`/ot` depends on the rewrite in `public/_redirects`; its comments say why the target
is `/` and why the rule sits above the splat. In a browser, `/ot?v=clean` selected
VersaTiles and added no `layers=`, and `/` used the default basemap.

With the service worker installed, a navigation to an unknown route is answered from
precache by `navigateFallback`, so it shows the app, not the 404 page. This is
deliberate: offline, that is the wanted behaviour.

## PWA: a data url in the address bar must not serve the app shell

**Covers:** `navigateFallbackDenylist` in `vite.config.ts` (AGENTS.md, Gotchas).
`pnpm preview` has no `/api` backend, so a denied navigation and a served shell look
the same locally.

**Result, 2026-07-30.** `https://satvis.space/api/groups.json` answers
`application/json` with or without an HTML `Accept` header, so the shell came from
the service worker. `workbox-routing/NavigationRoute._match` rejects a request whose
`mode !== "navigate"` before it reads the denylist, then tests `pathname + search`.
That is why `.json` missing from the extension list handed `/api/groups.json` to
`createHandlerBoundToURL("/index.html")`. Check the built `dist/sw.js` for the
`/api/`, `/data/` and `/cesium/` prefixes.

**Not verified:** a live navigation against a deployed Worker with the new service
worker installed. After a deploy, open the url in a tab and confirm JSON.

## Ground station link: drawn when switched on, free when not

**Covers:** the `Ground station link` component in
`src/modules/SatelliteComponentCollection.ts` (one dynamic polyline entity per
satellite) and its budget in `sceneSync.ts`. Whether it reaches the scene is
unit-tested; the frame cost is not.

**Procedure.** `pnpm build && pnpm preview`, then open
`?tags=Starlink&gs=48.1800,11.7500,Munich&elements=Point&framems=16`. Once every
satellite is active and the scene has settled, time `clock.tick()` plus
`scene.render()` from the console. Repeat with
`elements=Point,Ground+station+link`, look at Munich, and untick the link in the
satellite menu.

**Result, 2026-10-04, Chrome (frame pump on), 11,152 Starlink satellites.** Link
off: 18 ms a frame and no link entities. Link on: 109 ms a frame (about 8 µs per
satellite), activation about 4× slower, 281 links drawn from Munich. Unticking
removed all 11,152 link entities and dropped it from `elements`.

**Result, 2026-10-04, same setup, the first 1,000 catalog names.** Off, on, off in
one page, each settled: `dataSourceDisplay.update` 0.5 ms off and 8 ms on, a frame
21 ms and 30 ms. 50 links drawn.

## Clock deck: the replacement for the animation and timeline widgets

**Covers:** `src/components/ClockDeck.vue`, `src/composables/useClockDeckChrome.ts`
(the credit placement cases and breakpoints), `usePassHighlights.ts`, the
`body.clock-deck` rules in `src/css/main.css`, and the `Attribution` link text in
`createViewer.ts`.

**Geometry.** At any viewport:

```js
const cluster = document.querySelector(".cluster");
const surface = getComputedStyle(cluster, "::before");
const box = cluster.getBoundingClientRect();
const parts = [...cluster.querySelectorAll(".play__circle, .stamp, .mode, .reset")].map((el) => el.getBoundingClientRect());
const credits = document.querySelector(".cesium-viewer-bottom").getBoundingClientRect();
({
  // The surface hugs the controls, 8 px either side.
  surfaceLeft: box.left + parseFloat(surface.left) - (Math.min(...parts.map((p) => p.left)) - 8),
  surfaceRight: box.right - parseFloat(surface.right) - (Math.max(...parts.map((p) => p.right)) + 8),
  // It is flush against the band: one shape, not two.
  seam: document.querySelector(".scale-row").getBoundingClientRect().top - box.bottom,
  // The clock sits on the needle.
  clockOffset: (() => {
    const s = document.querySelector(".stamp").getBoundingClientRect();
    return (s.left + s.right) / 2 - innerWidth / 2;
  })(),
  creditBottom: innerHeight - credits.bottom,
  // The deck must not be the thing a tap on the credits hits.
  creditHit: document.elementFromPoint(credits.left + 20, credits.top + 14)?.className,
});
```

Then: tap the clock to fold and unfold (the clock and play button must not move);
tap the gauge to put the ladder on the band (the deck height must not change); swipe
the ladder and let go (it must coast and rest on a rung, `scrollLeft / 64` an
integer); drag the timeline and let go (the clock pins, `?time=` and the reset
button appear).

**Result, 2026-08-19, Chrome, 375x700, 390x844 and 694x800.** Surface 92.5 → 317.5
against controls at 100.5 → 309.5, so both edges exact. Seam 0.0, clock offset 0.0.
The credit logo and both links hit-test to themselves, and `Attribution` opens
Cesium's lightbox. Sky view cards sit at `bottom: 102px` with the deck and 64 px
without.

**Credit placement.** `useClockDeckChrome` sets `body[data-clock-deck]` to `clear`,
`stacked`, `beside` or `folded`, and main.css writes each offset in terms of
`--clock-deck-safe` and the safe-area insets. Read the computed variables, not the
pixels, which are right only without a home indicator. The breakpoints are measured
off the credit container's box, not its content (see the comment above
`@media (min-width: 1000px)`); changing the `Attribution` text or the 22 px logo
moves them.

**Result, 2026-08-19, Chrome, 694x800 and 1280x800.** `calc(51px + max(6px, 0px))`
beside the controls, `calc(3px + 0px)` folded and in the desktop corner,
`calc(var(--clock-deck-height) + 4px)` clear of the deck.

**Result, 2026-09-05, Chrome, emulated 447 / 448 / 623 / 624 / 1000 px.** 447:
clear, one line 4 px above the deck. 448: stacked, 113.4 × 39 with 10.6 px clearance
to the surface, centre 1.5 px above the clock's. 623: stacked. 624: beside, one line
201 × 25 with 10.8 px clearance. 1000: one line in the corner (2026-08-20: 13.8 px
clear of the scale row, fullscreen button 191 px clear).

**Result, 2026-08-23, iPhone 17 Pro, standalone, iOS 26.5.** With
`viewport-fit=cover` the insets are real. The folded corner placement is
`--credit-corner-bottom` / `--credit-corner-left` on `:root`, and the credit line
cleared the bottom edge by 40 pt (15 pt before). Every offset reduces to its old
literal at zero insets, checked in a desktop browser.

**Ruler width.** `--clock-deck-max` lives on `:root`, not on `body.clock-deck`: the
class arrives in the deck's `onMounted`, and the timeline measures its width in the
same tick. Check that hour labels are 150 px apart and the one before the needle is
no further from it than the clock is past the hour.

**Result, 2026-08-19, Chrome, 1280x800.** Ruler 560 px, 23 ticks, hour labels at
118.5 / 268.5 / 418.5, needle at 280, clock 21:04:48, so 21:00 sits 11.5 px left of
the needle (4.8 min is 12 px). Deck at 360–920, credits 277 px clear of it,
fullscreen button 331 px clear. Below 1000 px the fullscreen button is
`display: none` (checked at 900, back at 1280). The eye toggle removes and restores
the deck, the body class and the fullscreen button together.

**Pass bands.** Drive the seam directly; Vite returns the module instance the deck
imported:

```js
const mod = await import("/src/composables/usePassHighlights.ts");
const clockMs = Date.now(); // or the deck's own clock, if it has drifted
mod.setPassHighlights([{ start: clockMs + 5 * 60_000, end: clockMs + 13 * 60_000 }]);
```

**Result, 2026-08-19, Chrome, 1280x800.** A pass 5 min ahead lands 12.5 px right of
the needle and is 20 px wide (8 min at 1 h per 150 px). One 40 min behind lands
100 px left. One spanning the window is clipped to the ruler. One 10 h out is not
drawn.

**The scale row and the surface are one shape.** The row's top corners carry the
surface's 16 px radius, and two fillets (`::before` / `::after`, placed off
`--surface-left` / `--surface-right` on the deck) join them. Each fillet's computed
`left`/`right` is the inset less 16.

**Result, 2026-09-05, Chrome, emulated 800 and 1100 px.** Fillets at `left: 239px`
against a surface at 255, row radius `16px 16px 0 0`, the row's top-left pixel
hit-tests to the globe and 20 px lower to the timeline. Folded, the card is `16px`
all round and the row and fillets are gone. At 1100 the capped row is a 560 px card
with the same corners.

**Not verified on a device:** gesture feel (flick inertia, the ladder's settle,
whether 1 h per 150 px suits a thumb), and rotation, where the surface is
re-measured from the `resize` listener.

## Attribution lightbox: closable on a phone

**Covers:** the `.cesium-credit-lightbox-mobile` rules in `src/css/main.css`.

**Procedure.** Run the iOS app against the change, tap `Attribution`, then tap the
close button. In a desktop browser, open the lightbox and click outside it.

`make run URL=…` (ios/) does not work here: the simulator blanks a launch variable
named `URL`, so `SIMCTL_CHILD_URL` arrives empty and the app loads satvis.space. The
same value under another name arrives intact; this run used a temporary
`SATVIS_URL` pointed at `http://[::1]:<port>/`, since Vite listens on IPv6 loopback
only.

**Result, 2026-10-04, iPhone 18 Pro Max simulator, iOS 27.** Before: the full-screen
lightbox sat below the toolbars and the clock deck, its title and close button under
the Dynamic Island, and nothing closed it. After: it covers the app chrome, the
title and close button start below the status bar, and the close button dismisses
it. At 1024 px wide the windowed lightbox covers the toolbars, and a click outside
closes it.

## Tracking: the flight lands where tracking puts the camera

**Covers:** `src/modules/trackFlight.ts` (unit-tested bookkeeping) and its callers
in `SatelliteManager.ts` and `SatelliteComponentCollection.ts`.

**Procedure.** Open `?sats=ISS+(ZARYA),CSS+(TIANHE)&framems=16` and pause the
clock. Record the camera's world position (`camera.transform` applied to
`camera.position`) when `trackedEntity` is assigned and 20 frames later, for
untracked → ISS, ISS → CSS, and ISS → CSS → ISS interrupted mid-flight. Count calls
to `viewer.flyTo`. Repeat with the clock running, in 2D, and entering the sky view
mid-flight. Then, with a satellite tracked, click another satellite, press its Track
button, and stop tracking.

**Result, 2026-10-04, Chrome (frame pump on).** Paused: handoffs moved the camera
1.3 mm and 8 mm in the same direction, the interrupted chain landed once on the last
satellite, and only a deliberate untrack flew back. Running: the clock paused for
the flight and resumed on landing, and the offset from the satellite then changed
as in steady tracking (3.3–3.5 km over 20 frames). 2D tracked instantly. Entering
the sky view cancelled the flight, resumed the clock and tracked nothing. The Track
button flew, landed and wrote `track` to the url.

With ISS tracked among 653 satellites, clicking another opened its panel and left
the camera still and ISS tracked; its Track button then flew there. No camera move
on the click or after landing across four switches. (The pose probe runs on a
camera of its own: probing the real camera and restoring it with `setView` had
moved it about 11,000 km, because `setView` reads the position as world
coordinates.)

Stopping flies back to the view tracking began from: 0 km off and the same
direction after an animated track, after ISS then CSS, after an instant track, and
after tracking a ground station. Entering the sky view while tracking untracks
first, and leaving lands 0 km from the tracked view.

## Render on demand: a paused clock draws nothing

**Covers:** `requestRenderMode` in `createViewer.ts` / `CesiumController.ts`, and
the `CallbackProperty` users (sensor cone, ground station link).

**Procedure.** Open
`?elements=Point,Label,Orbit,Orbit+track,Ground+track,Sensor+cone,Ground+station+link&gs=48.1371,11.5754&framems=16`
and wait for the tiles to load. Count `scene.postRender` and `clock.onTick` events
for 5 s running and 5 s paused. Do not use `bench=true`: the benchmark panel turns
`requestRenderMode` off.

**Result, 2026-10-04, Chrome (frame pump on), 72 satellites.** Running: 113 renders
in 309 ticks. Paused: 0 renders in 310 ticks, with the sensor cone and the ground
station link on. A rerun gave 115 and 0, with `requestRenderMode` on throughout.

## Orbit batch: the line passes through the satellite, without a bend

**Covers:** `SampledTrajectory.positionsForNextOrbit` and the batched orbit in
`SatelliteComponentCollection.ts`. The unit tests stand TEME in for ICRF; this checks
the drift, the gap and the cost against the real IAU data.

**Procedure.** `?tags=&sats=ISS+(ZARYA),NOAA+20+(JPSS-1)&elements=Point,Orbit&framems=16`.
For starts 0.5, 5, 20 and 40 s ahead, and one whose period ends just past the last
sample (`inertial.lastTime()` less a period, plus 1 s), take the largest bend between
consecutive segments. For the gap, take the satellite's distance to the nearest segment
over the next three quarters of a period, both in the inertial frame. For cost, time
`positionsForNextOrbit` over `?tags=Starlink` once the build is done, against
`[head, ...getRawValues, head]` through `drawablePositions` in the same page.

**Result, 2026-10-06, Chrome (in-app browser pane, frame pump on).** Drift over one
period: ISS 31 km, NOAA 20 54 km. Closed straight back to the head, the largest bend was
ISS 7.6 to 42°, NOAA 20 3.2 to 6.1°. Now ISS 3.004°, NOAA 20 3.13 to 3.26°, the end past
the last sample included; 120 samples an orbit bend 3°. Worst gap: ISS 2.33 km, NOAA 20
2.47 km, the chord between samples (2026-10-05, before the head: 5.9 and 7.1 km). 11,146
orbits: 62 ms per full rebuild against 46 ms; the rebuild itself took 1.4 s on the main
thread (2026-10-05).

## Time-dependent imagery: GOES-IR and VIIRS follow the clock

**Covers:** `src/modules/GibsTimeLayer.ts`, `src/modules/util/timeDomain.ts` and the
`ImageryContext` in `CesiumLayerProviders.ts`. Which tiles Cesium asks GIBS for, and
whether a removed layer goes quiet, need the real globe and the real service.

**Procedure.** `?tags=&layers=VIIRS,GOES-IR&time=2026-10-03T15:07Z&framems=16` with a
viewport; raise `performance.setResourceTimingBufferSize` so the requests show. Move the
clock, group GIBS requests by the time in their path, run at 3600×, then
`setLayers(["NaturalEarth"])` and move the clock again.

**Result, 2026-10-05, Chrome (frame pump on).** 15:07 showed the 15:00 frame and an
hour later 16:00, all 200; live at 14:29 UTC, the latest published frame and today's
VIIRS. 3600×: ~53 requests a second, frames p50 16 ms, p99 36 ms. After removal, no
GIBS requests and the layers' clocks stopped following the viewer's.

## 3D models: visible from afar without crowding the globe

**Covers:** `modelMinimumPixelSize` and the model graphics in
`SatelliteComponentCollection.ts` (the minimum itself is unit-tested). How big a
model looks, and whether it hides the globe or its neighbours, is a picture. The
bounding sphere says little about what a model covers: Landsat's is mostly one dark
solar wing, FOREST-3's a bright box that fills it.

**Procedure.** Open
`?elements=Point,Label,3D+model&sats=ISS+(ZARYA),LANDSAT+8,ICESAT-2,GRACE-FO+1,GRACE-FO+2,FOREST-3&framems=16`,
pause the clock and look at each model from 16,000 km and closer. For the pixels a
model covers, render with its `model.show` off and on and count the pixels that
differ; judge looks at a 1:1 css crop, since the pane's screenshots are scaled.
`minimumPixelSize` is in css pixels: Cesium's `Camera.getPixelSize` already applies
`scene.pixelRatio`.

**Result, 2026-10-05, Chrome (frame pump on), 800×600 at ratio 2, Landsat 8 and
FOREST-3 in one view from 16,000 km.**

| `minimumPixelSize`                   | Landsat 8 (13.4 m sphere) | FOREST-3 (0.64 m sphere) |
| ------------------------------------ | ------------------------- | ------------------------ |
| `50`, `maximumScale: 10000` (before) | a speck                   | under a pixel            |
| log, 24–48 px                        | 37×22 px, 233 px²         | 19×16 px, 209 px²        |
| the same × `pixelRatio` (a bug)      | 76×45 px, 976 px²         | 38×33 px, 875 px²        |
| cube root, 20–72 px (shipped)        | 55×33 px, 506 px²         | 15×13 px, 143 px²        |

Under the log curve FOREST-3 looked the bigger of the two. Under the cube root
GRACE-FO is 36 px and the ISS 72, and each model takes its real size once that is
larger. GRACE-FO 1 and 2 still touch at 20,000 km. Paused, the scene drew 0 frames
in 248 ticks with the models on.

**Zooming out, same setup at 1400×900.** Move the camera out along its own direction
to 1, 2, 4 and 10 times the default view's distance from the Earth's centre, and crop
each frame to the same globe size. Without `maximumScale` the minimum held every
model at 20–72 px however small the globe got: at 10× the ISS and Landsat covered the
disc. With the cap, 1× matched the uncapped frames, and further out every model kept
its default-view share of the globe, the ISS about a tenth of its diameter.

## 3D models beside the other components

**Why it cannot be a unit test.** The label offset and the point's visibility are
unit-tested against a stubbed camera; whether a label clears its model, and which
component hides which, is a picture.

**Procedure.**
`?tags=&elements=Point,Label,Orbit,Orbit+track,Ground+track,Sensor+cone,3D+model,Ground+station+link&gs=48.1371,11.5754,Munich&sats=ISS+(ZARYA),LANDSAT+8,ICESAT-2,GRACE-FO+1,GRACE-FO+2,FOREST-3&framems=16`,
paused. Look at each model from 16,000 and 3,000 km at a 1:1 css crop with one other
component at a time (`cc.sats.suppressComponent`, `releaseComponent`), then read each
label's `pixelOffset` and point's `show` at 1, 2 and 4 times the default view's
distance.

**Result, 2026-10-05, Chrome (in-app browser pane, frame pump on), ratio 2,
800×600.** Before, the label sat a fixed 20 px right of centre, over the ISS (72 px)
and Landsat (55 px), and the point sat on the model's centre. After, labels start 40, 31
and 13 px out for the ISS, Landsat and FOREST-3 at the default view, and 15, 12 and
10 px at four times its distance. The point is hidden while the model is 10 px or
more across, which by their 20, 55 and 72 px minimums brings it back at about 2, 5.5
and 7 times the default distance for FOREST-3, Landsat and the ISS (computed, not
re-measured). Orbits, tracks and the ground station link run through or under the
model; the sensor cone, drawn at real size, shows as a stub beside it from afar.
Paused, the scene drew 0 frames in 230 ticks with every component on.

## FXAA: what it smooths and what it costs

**Why it cannot be a unit test.** Both questions are about pixels and GPU time on a
real context.

**Procedure.** `pnpm build && pnpm preview`. For quality, open
`?elements=Orbit&framems=16`, hide the globe, sky box, atmosphere, sun and moon,
pause the clock, and compare no antialiasing, MSAA 4x and FXAA against the same frame
rendered at `resolutionScale` 3 and box-filtered down. For cost, open
`?bench=true&framems=1` and count `postRender` events in alternating blocks of FXAA
off and on, pairing each on block with the off block before it.

**Result, 2026-10-06, Chrome 152 (in-app browser pane, frame pump on), Apple M4 Pro,
ANGLE Metal, ratio 2.** Orbit RMSE against the reference, in 8-bit levels: 17.9
without antialiasing and with MSAA 4x (the same pixels), 10.1 with FXAA; 18.5 and
10.2 at twice the default distance. FXAA changed 27% of label pixels by a mean of
1.3%, invisible at four times magnification, and 1.6% of a frame without orbits.

Cost at 2800×1800 with the default 72 satellites, ms per frame of throughput under
the pump: HDR on, FXAA off 11.8 and on 10.5; HDR off, 8.6 and 11.0. Under HDR FXAA
makes the frame faster, because the texture handed on is its 8-bit output rather than
the tonemapper's float one; every one of eight paired blocks was 2.2–2.9 ms faster.
`gpuMs` stays blank, since the benchmark distrusts this driver's timer queries. Not
measured on another GPU or at ratio 1.
