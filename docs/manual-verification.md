# Manual verification

Checks that no test suite runs yet. `pnpm test` runs in node, with no layout
engine, no GPU and no render loop. The checks that need only a browser are moving
to the Playwright suite in `e2e/` (`pnpm test:e2e`, plan in
`docs/manual-verification-replacement-plan.md`); each one leaves this file when its
spec lands.

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

## Surface models: an unavailable model reverts and says so

**Covers:** the failure path of `src/modules/SurfaceModel.ts` and the surface radio in
`src/components/Satvis.vue`. What each model does to the view is `surfaceEffects`
(`src/config/surfaceModels.ts`, unit-tested), which the menu and the globe both read.

**Procedure.** With ion unreachable, select `GooglePhotorealistic` in the Map menu.

**Result, 2026-07-29, Chrome, `VITE_CESIUM_ION_TOKEN=not-a-real-token`.** A toast
read "GooglePhotorealistic unavailable … Cesium ion needs a token valid for this
origin", the radio went back to `None`, and `surface` left the url.
`SurfaceModel.apply` ran twice (the attempt and the revert), so the failure is
reported once.

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

## Clock deck: nothing covers the controls, and the gestures hold still

**Covers:** `src/components/ClockDeck.vue`, `src/composables/useClockDeckChrome.ts`
(the credit placement cases and breakpoints), the `body.clock-deck` rules in
`src/css/main.css`, and the `Attribution` link text in `createViewer.ts`. The
time-travel journey and `e2e/regressions/timelineRelease.spec.ts` cover the
timeline drag and its release.

**Procedure.** At 375, 447, 448, 623, 624, 1000 and 1280 px wide, hit-test the
centre of the deck's controls, the scale row, the credit logo and both credit links,
and above 1000 px the fullscreen button: each must reach itself. Read
`body[data-clock-deck]`. Then tap the clock to fold and unfold (the clock and play
button must not move), tap the gauge (the deck height must not change), and swipe
the ladder and let go (it rests on a rung: `scrollLeft / 64` is an integer).

The breakpoints are measured off the credit container's box, not its content (see
the comment above `@media (min-width: 1000px)`), so changing the `Attribution` text
or the 22 px logo moves them.

**Result, 2026-09-05, Chrome, emulated 447 / 448 / 623 / 624 / 1000 px.** 447:
`clear`, one line above the deck. 448 and 623: `stacked`. 624: `beside`. 1000: one
line in the corner. Every control and credit hit-tests to itself (2026-08-19 at 375,
390 and 694 px; 2026-08-20 at 1000 px, the fullscreen button clear of the scale row).
Below 1000 px the fullscreen button is `display: none`.

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
