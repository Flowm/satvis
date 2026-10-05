# Manual verification

Checks that cannot be automated with the current test setup, written down so the
result is a record rather than a memory. Each one says what was checked, how, and
what it returned — rerun it when the code it covers changes.

`pnpm test` runs in jsdom, which has no layout engine: it cannot answer
`getBoundingClientRect`, `elementFromPoint`, or anything about stacking. A
browser-driven test runner would replace this file; until then it is the record.

## Sky view: the HUD does not swallow clicks

**Why it cannot be a unit test.** The HUD is a transparent full-viewport layer, so
a control it covers still _looks_ fine — the failure is invisible and only a real
hit test finds it. `#cesiumContainer` is a sibling before `#app`, and `#app`
isolates its stacking context, so no z-index can lift Cesium's own widgets above
anything rendered inside the app. The arrangement that works is HUD root at `z-4`
with `pointer-events: none`, app toolbars at `z-6`, `.entity-info-panel` at `z-5`,
and look-around listening on the Cesium canvas rather than on an overlay.

**Procedure.** Open `?scene=Sky&gs=48.1400,11.5800`, wait for the scene to settle,
then for each control take its bounding box, call `document.elementFromPoint` at
the centre, and assert the control contains what comes back.

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

The entity info panel needs a selection first — `cc.viewer.selectedEntity =
cc.sats.activeSatellites[0].defaultEntity`.

**Result, 2026-07-27, Chrome, desktop viewport 1618x1576.** All six clickable.

The two Cesium widgets in that list are now the clock deck instead, which no longer
depends on the platform — `createViewer` builds neither widget anywhere. What does
still vary is the fullscreen button, absent under `minimalUI`.

Since the compass control moved to the View menu the HUD holds nothing interactive
at all, which makes the arrangement above easier to keep rather than harder.

## Sky view: the zoom gestures

**Why it cannot be a unit test.** The clamp and the curve are unit-tested; what is
not is that a wheel or a pinch reaches the handler and moves only the field of view.
That needs real event dispatch against a live canvas.

**Procedure.** Open `?scene=Sky&gs=48.1400,11.5800`, then dispatch synthetic
`WheelEvent`s and `PointerEvent`s at `cc.viewer.scene.canvas`, reading
`cc.skyView.fovy` and `cc.skyView.aim` between them. Two fingers 100px apart
widening to 200px should halve the field of view; the aim must be identical before
and after.

**Result, 2026-07-28, Chrome.** Wheel: 75° → 55.561° → 41.161° on equal notches
(constant ratio, i.e. multiplicative), and −200/−200/+400 returns to exactly 75°.
Clamps at 10° and 90°. A `deltaMode: 1` line delta of −3 steps 75° → 69.79°, so
Firefox-style deltas are not a no-op. Pinch: 60° → 30° at 2× separation and → 20°
at 3×, computed from the gesture start rather than accumulated. The aim was
byte-identical across every wheel notch and through the whole pinch, and a drag
after the second finger lifted moved the aim without a jump.

Note that a hidden browser tab reports `clientWidth/clientHeight` of 0 and never
fires `requestAnimationFrame`, so Cesium's render loop stalls and the globe stays
blank — drive `scene.render()` by hand when checking anything visual this way. A
hidden tab also will not restyle a pseudo-element for a `checked` property set from
script, so a switch's slider colour cannot be read that way; check the `checked`
property instead, or take a screenshot, which fronts the pane.

## Sky view: the compass tape holds its scale

**Why it cannot be a unit test.** `headingOffset` is unit-tested against a
from-scratch projection, including the `1/cos(pitch)` divergence it exists to avoid.
What that cannot show is the tape staying legible while a live view is dragged
upward.

**Procedure.** Open `?scene=Sky&gs=48.1400,11.5800`, then step
`cc.skyView.look({ pitch })` through 0, 30, 60 and 85 and read the tick offsets out
of the HUD, checking the spacing between adjacent ticks does not change.

**Result, 2026-07-29, Chrome.** Spacing constant at every pitch, and the tape keeps
its marks pointing at the zenith. Before the change, 15° of azimuth spanned 147 px at
eye level and 1691 px at 85° of pitch, and the visible window collapsed from ±15° to
nothing.

## Sky view: a drag takes the aim back from the compass

**Why it cannot be a unit test.** The handover spans the pointer handlers, the sensor
subscription and the View menu's control, and reaching it needs pointer events against
a live canvas and orientation events the sensor would send — the same reason the zoom
gestures are checked here.

**Procedure.** Open `?scene=Sky&gs=48.1372,11.5756,Munich`. Stand in for a phone by
dispatching a `deviceorientationabsolute` event every 100 ms with `absolute: true` and
a fixed `alpha`/`beta`/`gamma`, then switch the control on in the View menu. Drag on
`cc.viewer.scene.canvas` with `PointerEvent`s, reading `cc.skyInteraction.orientationActive`,
`cc.skyView.aim` and the control's `checked` property between them.

Two harness notes, both of which cost an hour before they were understood.
`setPointerCapture` throws `NotFoundError` for a pointer id the browser has not
physically seen, and it throws from inside `#onPointerDown` — so the rest of that
handler never runs and a synthetic two-finger gesture silently degrades into a
one-finger drag, which looks exactly like the bug you are testing for. Stub
`canvas.setPointerCapture`/`releasePointerCapture` to no-ops for the duration. And
take a screenshot before measuring anything angular: a hidden pane reports a canvas
of 0×0, and the drag's degrees-per-pixel comes off the canvas height.

**Result, 2026-08-05, Chrome.** Aiming from the fake sensor at azimuth 258.49°, pitch
−29.50°, roll −5.73°. A 5 px nudge inside the tap slop changed nothing — still aiming,
control still on, so selecting a satellite does not cost the compass. A 40×40 px drag
turned the sensor off, levelled the roll to 0 and moved the aim to 254.64° / −25.54°,
which is the drag's own 4.2° at that canvas height; 300 ms of further sensor readings
did not pull it back, and the control had unticked itself. Dragging during the 1200 ms
probe returned `taken-back` with the sensor off, the roll level, the control unticked
and no toast raised. Note a hidden tab throttles that probe's timer to minutes, so
collect the outcome in a later call rather than awaiting it.

**A pinch must not cost the compass either, 2026-08-06, Chrome.** Two fingers 100 px
apart spread to 200 px halved the field of view, 75° → 37.5°, with the sensor still
aiming; lifting the second finger and twitching the survivor 3 px left it aiming; and
the gesture selected nothing, so a pinch is still not a tap. The survivor then
dragging 100 px did hand the aim over, so the handover itself is intact. This is what
the review caught: the pinch's re-seed used to set `#dragged = TAP_SLOP + 1` to mean
"not a tap", and the handover read that same counter, so the first pixel after a
pinch ended compass aiming. Two fingers never leave the glass simultaneously, so on
touch it was close to unconditional.

## Sky view: the movement keys walk the observer and the station follows

**Why it cannot be a unit test.** The arithmetic of a walk is unit-tested
(`SkyMovement.test.ts`), and so is what sceneSync does with the observer it is
handed — including that the walk lands on the _designated_ station and leaves it
where it is in the list (`sceneSync.test.ts`). What is not is the chain between
them: a key pressed on `window` reaching the handler, `preRender` driving the step,
and the settle writing through the store to the url.

**Procedure.** Open `?scene=Sky&gs=48.1372,11.5756,Munich`, wait for the descent to
land, then dispatch `KeyboardEvent`s on `window` with the `code` under test,
reading `cc.skyView.observer`, `cc.skyView.eyeHeight` and the `gs` parameter
between them. A hidden tab pauses `requestAnimationFrame` and clamps timers to a
second, so hold the key and hand `cc.skyInteraction.movement.step` its own
timestamps for the walk itself — with `cc.viewer.render()` on an interval to prove
the `preRender` path separately.

**Result, 2026-08-05, Chrome.** A held `KeyW` through real frames moved the
observer south — the default aim at a northern latitude faces the equator — at
2 m per capped step, which is the frame clamp doing its job on a tab rendering once
a second. Driving the clock instead: one second of shift-held `KeyW` moved 176 m
(160 m of sprint plus one clamped 100 ms first step), the url stayed put while the
keys were down, and 350 ms after the keyup `gs` became `48.1340,11.5756,Munich` —
name kept, rounded to the store's precision, and the observer snapped to that
rounded point. `KeyE` for three seconds took the eye to 498 m and the horizon rose
to the 0° tick on the elevation tape. Q past the ground stops at 2 m and E past the
ceiling stops at 5000 m. Leaving for 3D with `KeyW` still down landed the exit
flight normally and wrote nothing: an unsettled walk is dropped rather than moving
a station on the way out, which is what would otherwise turn the exit around. No
console errors throughout.

## Entity info panel: the tab set, the timeline and the pass link

**Why it cannot be a unit test.** The layout arithmetic is unit-tested
(`passTimeline.test.ts`), the derived facts are (`orbitFacts.test.ts`), and so is
the formatting (`PassPredictor.test.ts`). What is not is the wiring: which tab
survives a change of selection, whether picking a block on the strip scrolls its
row into view, and whether entering the sky view from a station leaves the panel
open.

**Procedure.** Open `?sats=ISS%20(ZARYA)&gs=48.13,11.58,Munich_47.27,11.39,Innsbruck`.
On the satellite: click a block on the strip and read which row carries the
highlight; switch to `Details`; then select a ground station and read which tab is
active. On the station: press the telescope button and read `gs`,
`cc.skyView.observer` and whether the panel is still up.

**Result, 2026-08-12, Chrome (in-app browser pane, with a temporary rAF pump — the
globe needs frames).** Clicking the fourth block highlighted the `Munich 8 h 19 m
07:41:48` row and left the clock running, which is the point of picking rather
than time-travelling. Switching to `Details` and then selecting Innsbruck clamped
the active tab back to `Passes` rather than rendering an empty body — the bug this
clamp exists for — with the tab list hidden, since a station has only one tab, and
no timeline, since 511 passes across every satellite is a forest. The telescope
button stood the sky view at `{lat: 47.27, lon: 11.39}` with `gs` unchanged in
order and the panel still open on Innsbruck. No console errors throughout.

**The fold, added 2026-08-20.** Pressing the tab you are already on folds the body
away, so on a phone the panel stops covering the globe and the passes the clock deck
marks on its ruler. Reka's tab trigger sets the model on every press including an
unchanged one, so the fold lives in `activeTab`'s setter; there is no click handler
to keep in step with it.

**Result, 2026-08-20, Chrome, 390x844.** Panel 491 px open and 145 px folded, which
is the header, the position strip and the tab row. Pressing the active tab folds and
unfolds it repeatedly; pressing the other tab while folded switches and expands in
one press, from either tab. Folded, 556 px of globe stand between the panel and the
deck, and a pass ten minutes ahead of the clock draws 29 px wide at 220 px along a
390 px ruler.

## Sky view: the observer is a designation, not the first station

**Why it cannot be a unit test.** Which station the sky view stands at is
unit-tested at the seam (`sceneSync.test.ts`) and the index arithmetic is
unit-tested pure (`groundStationEdits.test.ts`). What is not is that the three
readers agree once a real list, a real Cesium scene and the ground station panel
are all in play: entry resolves the designation, the live view follows a change of
designation, and reordering the list does not quietly move the view.

**Procedure.** Open with three stations —
`?gs=48.13,11.58,Munich_47.27,11.39,Innsbruck_51.51,-0.13,London` — and drive the
panel: press a station's rank to designate it, drag or arrow-key a row to reorder,
press a row's × to remove. Read `cc.skyView.observer`, the `gs` parameter and which
row carries the ◉ between them. Entering from a station's info panel is the fourth
path.

**Result, 2026-08-11, Chrome (in-app browser pane, with the rAF pump — the descent
needs frames).** Entering from London's info panel stood the view at
`{lat: 51.51, lon: -0.13}` with `gs` unchanged in order, the ◉ on row 3, and the
info panel still open on London — no station entity was rebuilt, which is what the
old reorder did. Pressing rank 2 moved a live view to Innsbruck
`{lat: 47.27, lon: 11.39}`, list order untouched. Arrow-keying Munich down past
Innsbruck carried the ◉ with Innsbruck to row 1 and left `cc.skyView.observer`
exactly where it was — a reorder is not a move. With London designated, removing
Munich left the ◉ on London at row 2 and the observer unmoved. The GEO arc read
Meteosat-12 at 30.3° elevation, 180.4° azimuth from London, which is the right arc
for that latitude. No console errors throughout.

**Not re-run.** The held-key walk above, whose chain this change does not touch —
only the store write at the end of it, which is unit-tested.

**Re-checked after the ground-measurement fix, 2026-08-06, Chrome.** Same walk, now
measuring on the 250 ms throttle rather than falling back to `globe.getHeight`: the
eye height held steady at 2 m across the whole sprint and the settle still wrote
`gs`. **Still unverified:** the case the fix exists for — walking under
`surface=GooglePhotorealistic`, where the old fallback could read the hidden globe's
ellipsoid as a plausible 0 and drop the eye through the mesh. That needs an
unrestricted `VITE_CESIUM_ION_TOKEN`, which this run did not have. Check it the way
the surface-model entries below are checked, recording `camera.positionCartographic.height`
every `preRender` while holding `W` in Munich; it must stay near the mesh top (~570 m)
rather than falling to 2 m.

## Worker: missing files 404, and none of it is billed

**Why it matters.** `not_found_handling: "single-page-application"` answered every
unmatched path with `index.html` and a 200, which is what made `response.ok` meaningless
for the imagery probe and let the service worker cache the app shell under tile urls. The
constraint on any fix is that it must not turn asset traffic into billed Worker
invocations.

**Procedure.** `pnpm build`, `pnpm dev:worker`, then request each path and read the status.
For the billing half, put `console.log("BILLED", new URL(request.url).pathname)` at the top
of the Worker's `fetch` and watch which requests appear.

**Result, 2026-07-30, wrangler dev on the built dist.**

| path                                     | status                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `/`, `/ot`                               | 200 text/html                                                            |
| `/embedded.html`, `/test.html`           | 307 to `/embedded`, `/test` (asset router `html_handling`, pre-existing) |
| `/typo-route`                            | 404 text/html (the 404 page)                                             |
| `/api/groups.json`                       | 200 application/json                                                     |
| `/cesium/…/tilemapresource.xml` (exists) | 200 application/xml                                                      |
| `/data/imagery/…` (a missing tile)       | **404**                                                                  |
| `/data/gp/weather.json` (absent)         | **404**                                                                  |

Of those six requests, **only `/api/groups.json` logged `BILLED`** — routes, unknown paths
and missing files are all answered by the asset router. Two combinations that are _not_
free, both measured: `404-page` with no `404.html` falls through to the Worker, and
`not_found_handling: "none"` invokes it for every unmatched path.

`/ot` returning 200 depends on the `_redirects` rewrite `/ot / 200`. Two details it is
easy to get wrong, both found by testing: the target must be `/` and not `/index.html`,
because the asset router strips the extension and answers with a 307 to `/`, which would
send the route to the default preset; and wrangler warns that a static rule placed after a
dynamic one cannot be matched as cheaply, so it goes above the splat rule.

**A trap when checking this in a browser.** The app writes its state into the query, so
re-visiting the bare path in the same tab can land on the previously written url — `/ot`
became `/ot?layers=Offline` from an earlier visit, which looked exactly like the OT preset
failing to apply. Navigate with a distinct query (`/ot?v=clean`) to be sure of a fresh
state. Verified that way: `/ot` selects VersaTiles and adds no `layers=` to the url, while
`/` uses the default basemap as it should. (Recorded when that default was named
`Offline`; it is `NaturalEarth` now, and the behaviour is what was checked.)

For comparison, production before this change answered a missing data asset with
`200 text/html`.

**One inconsistency worth knowing:** with the service worker installed, a navigation to an
unknown route is answered from precache by `navigateFallback`, so it shows the app rather
than the 404 page. The server and the service worker disagree there, deliberately — offline
that is the behaviour you want.

## Layers: the base map's depth upgrade

**Procedure.** Open a checkout where `data/imagery/NaturalEarthII/3/` is absent — one where
nobody has run `pnpm update-imagery`, which any fresh clone is — and load the default route.
Read the basemap selection, the url, and the console, then zoom in past continent scale. Then
run the generator, reload, and zoom in again. Do **not** simulate the absent case by deleting
files from a running dev server: see below.

**Result, 2026-08-04, Chrome, dev and built preview.** Basemap `NaturalEarth` in both cases,
url untouched, console clean, and a correct globe either way — `maximumLevel` 2 without the
generated levels and 5 with them. Nothing about the selection changes; only the ceiling does.
The ceiling is a build-time `define`, so the restart after running the generator is expected.

**Above the ceiling the map is complete, not holed.** Checked directly by building with levels
4–5 removed while the ceiling stayed at 5, so Cesium requested tiles that did not exist: the
Alps and Italy rendered in full from magnified level-3 imagery, with visible rectangular seams
where neighbouring terrain tiles magnify by different amounts. That is `TileImagery` walking up
to the closest ready ancestor, and it is the same path taken offline in a region the runtime
cache has never held — which is why the precache goes to level 3 rather than 2.

One measurement worth keeping from the attempt that failed: in the built preview a ranged
request for a missing tile returns **206 with `content-type: text/html`**, the SPA fallback
honouring the Range header. `response.ok` is true. Any probe that trusted status alone would
have reported the deep levels present.

**What this replaced, and why it is worth remembering.** The old arrangement asked whether the
imagery was _missing_ and, if so, rewrote the layer selection to a second `Offline` provider
backed by Cesium's own differently-graded tiles — so the failure was visible as a colour shift,
a changed url and a warning. Two bugs came out of that shape. The first: a probe answering
after the route's preset had hydrated clobbered the preset's chosen basemap. The second is
worth its own paragraph, because it is about method rather than code.

**The result recorded here for 2026-07-28 was simply wrong.** It reported the fallback firing,
but the probe tested only `response.ok`, and in a real unpopulated checkout the request for the
missing manifest was answered by the SPA fallback with **200 and `index.html`** — measured,
`content-type: text/html`, 1065 bytes of markup. The probe concluded the imagery was present
and the globe stayed blank, which is what was being reported from worktrees all along. That is
why every probe in this app checks what came back and not just its status, and why the levels
the globe cannot do without are committed rather than probed for at all.

Deleting the file from a running dev server most likely produced a 404 instead — the
static-copy middleware owns that path and fails outright, where a file that never existed
falls through to the SPA fallback. That is inference, not measurement, but it is reason
enough that this check must be run on a genuinely unpopulated checkout rather than a
simulated one.

## PWA: a data url in the address bar must not serve the app shell

**Why it is here.** The two halves are checkable separately but the whole needs a
deployed Worker plus an installed service worker, which no local setup reproduces: served
by `pnpm preview` there is no `/api` backend, so a denied navigation and a served shell
look identical.

**What was checked, 2026-07-30.** `https://satvis.space/api/groups.json` answers
`content-type: application/json` with the real index, with or without an HTML `Accept`
header — so the server was never the problem; the app shell came from the service worker.
`workbox-routing/NavigationRoute._match` rejects any request whose `mode !== "navigate"`
before consulting the denylist, and then tests `pathname + search`, which is why `.json`
missing from the extension list was enough to hand `/api/groups.json` to
`createHandlerBoundToURL("/index.html")`. The built `dist/sw.js` now carries
`denylist:[/\.(css|js|...)$/,/^\/api\//,/^\/data\//,/^\/cesium\//]`.

**Not checked:** a live navigation against a deployed Worker with the new service worker
installed. Worth doing after the next deploy — open the url in a tab and confirm JSON.

## Map menu: the Basemap/Overlays split, and Re:Earth terrain

**Procedure.** Open `?layers=ArcGis_0.5,Nextrad&terrain=ReEarth`, read the two imagery
groups, switch basemap, toggle an overlay, and fly somewhere with relief.

**Result, 2026-07-30, Chrome.** Basemap radios listed `Offline`, `OfflineHighres`,
`ArcGis`, `OSM`, `BlackMarble` with **ArcGis checked**[^basemaps] — bound by provider, so the `_0.5`
token still reads as the layer it is, which the old flat checkbox list did not. Overlays
listed `Tiles`, `GOES-IR`, `Nextrad` with Nextrad checked. Switching to OSM rewrote
`?layers=OSM,Nextrad`, keeping the overlay and dropping the old basemap's opacity, which
belonged to a layer no longer in the stack. Toggling `Tiles` gave `OSM,Nextrad,Tiles` and
three imagery layers, and untoggling gave back two.

Re:Earth terrain resolved `https://terrain.reearth.land/cesium-mesh/ellipsoid/` and
rendered the Bernese Alps with correct relief. Its required credit — "Re:Earth Terrain ·
Mapterhorn (CC BY 4.0)" — appears in the "Data attribution" display, alongside the
service's own layer.json credits (Mapterhorn, EGM2008, Protomaps, OpenStreetMap).

VersaTiles rendered the whole globe the right way up (no `{reverseY}` needed, since its
TileJSON declares no `scheme`) and resolved to sharp orthophoto over central Munich, with
tile requests observed from level 7 to 14 and no errors. "VersaTiles sources" is in the
attribution display. **Note for whoever runs this next:** an unfocused browser tab
throttles `requestAnimationFrame` to a standstill, so Cesium stops refining and the globe
sits on whatever coarse level it had — which looks exactly like broken imagery. Front the
tab, or drive `cc.viewer.scene.render()` in a loop, before concluding a provider is at
fault.

Worth re-running if the terrain looks flat: this is a free, keyless service on
best-effort uptime with no SLA, so it is the one terrain that can simply stop answering.

## Sky view: enabling a surface model must not lurch or flip

**Why it cannot be a unit test.** The symptom is a sequence of camera positions across
frames while terrain streams, which needs a live globe and a real network.

**Procedure.** Enter the sky view with `?scene=Sky&gs=48.1372,11.5756,Munich` and no
surface model, then enable OsmBuildings while recording `camera.position` and `camera.up`
on every `preRender`.

**Result, 2026-07-30, Chrome.** Two distinct eye heights, 2 m then 572.8 m — one
transition, in the same frame the terrain provider becomes World Terrain — and `up.z`
constant at 0.979 throughout, i.e. no orientation change. 572.8 m is CWT's Munich ground of
570.8 m plus the 2 m eye height.

Before the fix the same trace showed the eye stuck at 2 m while the provider had already
become World Terrain, leaving the camera ~570 m under the new ground (the reported flip:
inside terrain you see its underside), followed by a step per terrain refinement as
`getHeight` improved its answer — including one reading of -76639, which the plausibility
guard rejected.

## Sky view: moving the observer must not drop the eye underground

**Why it cannot be a unit test.** The symptom is a camera position across frames while an
asynchronous height measurement is in flight.

**Procedure.** Settle the sky view over Munich with OsmBuildings, then move the observer —
`cc.skyView.enter({ lat, lon })`, which is exactly what a station drag or an arriving
geolocation fix does — recording `camera.position` every `preRender`.

**Result, 2026-07-30, Chrome.** One height throughout, 572.8 m, `up.z` constant at 0.979.
Before the fix the move reset the ground height to sea level, putting the eye at 2 m while
Munich's ground is 570 m — 568 m underground for as long as the measurement took.

Worth knowing what that looks like, because it does not look like a wrong height: from
under a surface you see its underside wearing the same imagery, so the frame fills with
what reads as a plan view of the city, a horizon-like edge where the mesh ends, and black
below. It was reported as the world flipping. Reproduce it deliberately with
`cc.skyView.setGroundHeight(0)` over any city.

## Sky view: the terrain hides the satellites behind it

**Why it cannot be a unit test.** The question is which pixels ended up in the frame
buffer, so it needs a GPU: the satellites are drawn where they are, and whether the
mountain in front of them wins is decided by the depth test rather than by any value
this code holds.

**Procedure.** Enter the sky view over a place with relief —
`?terrain=ReEarth&scene=Sky&elements=Point&tags=Starlink,Weather,Stations&gs=47.3879,12.3077`,
the Kitzbühel Alps — then, for every satellite whose position projects inside the
viewport, compare the brightest pixel within 4 px of that projection between a frame
rendered with `scene.globe.depthTestAgainstTerrain` on and one with it off. A satellite
point reads 173 against terrain's 45-70, so "drawn" is unambiguous. The observer's local
elevation for each comes from the same positions, against the geodetic normal at the eye.

**Result, 2026-08-10, Chrome.** 133 satellites on screen. With the depth test off — what
shipped — 94 were drawn, from 0.96° _below_ the horizon to 67° above it. With it on, 48
were drawn and the lowest was at 9.28°, which is the ridge line in that direction. The 46
that went away spanned -0.96° to 14.26°, and nothing appeared that had not been drawn
before, which is the property that matters: the fix only ever takes away.

Two things worth knowing about the frame this replaces, both established by disabling
`Scene`'s depth plane (`scene._depthPlane.execute = () => {}`) and re-rendering:

- The sub-horizon sky was already being hidden, by the depth plane rather than by the
  ground: with the plane suppressed, satellites at -7° drew at full brightness too.
- The plane's cutoff is about a degree short of the horizon — satellites from -0.96° up
  came through. That follows from its geometry: it is a quad of the limb's radius, ~101 km
  from an eye 800 m up, and a ray a degree below the horizontal clears its edge.

So the missing occlusion was relief specifically, which is why the report named terrain.

**Labels, 2026-10-04, Chrome.** The depth test above hid the points and not their
labels: beyond the label collection's `coarseDepthTestDistance` (~636 km) Cesium's
billboard shader tests against the ellipsoid only and writes its depth in front of the
globe. At `?scene=Sky&gs=46.5935,7.9091&terrain=ReEarth&time=2026-10-04T20:00Z`, the
Lauterbrunnen valley looking south, five of the 72 weather-satellite labels (METEOSAT-9,
CYGFM07, CYGFM02, FENGYUN 3F, ELEKTRO-L 2) were drawn on the cliff faces with no point
beside them. With `SkyView` raising the distance to infinity all five went and the five
above the skyline stayed. Leaving the view put the distance back to 635,675 m.

## Sky view: the crosshair agrees with the picture

**Why it cannot be a unit test.** `groundHides` casts a ray at the tiles the globe
rendered this frame, so what it answers depends on a live globe with terrain streaming
into it. The predicate's ordering and its effect on the lock _are_ unit-tested
(`SkyTargets.test.ts`); what needs a browser is whether its answer matches the frame.

**Procedure, two parts.** Same place and terrain as the entry above.

1. For every satellite above the horizon that projects inside the viewport, compare
   `groundHides` against whether the render drew it (brightest pixel within 4 px).
2. Aim the view at each of 25 satellites in turn so the crosshair sits on it, render,
   and compare `cc.skyInteraction.locked` against the pixel at screen centre.

**Result, 2026-08-10, Chrome, 11,011 satellites.** Part 1: 87 of 88 agreed. The one
exception sat at 9.7° on a ridge silhouette, where the ray meets a tile the drawn mesh
dips below — it declines to lock something at the very edge of a ridge. Part 2: 25 of
25 agreed — 8 drawn satellites locked, 17 terrain-hidden ones did not.

Part 2 needs **two renders per aim**, and the reason is a real one-frame lag rather than
a quirk of the harness: the lock is computed in `preRender`, so the tiles it rays against
are the ones the _previous_ frame drew. A synthetic jump to a new azimuth therefore asks
about the old view and answers wrong for exactly one frame; a drag, which moves the aim
by a few degrees a frame, never notices.

Cost, measured warm: about 10 µs a ray. The crosshair had four candidates inside its
reach and needs at most one ray each; the trace's 25 samples came to 0.23-0.31 ms for the
whole batch, on the 500 ms sampling interval rather than per frame. Frame time at 11,011
satellites stayed at 11.5-14.4 ms throughout, with no visible spike on a sampling frame.
Cold, the first rays of a session measured up to 2 ms — worth knowing before reading a
single timing as the steady state.

## Surface models: the matrix, the eye height, and what drapes on a mesh

The pure part is unit-tested (`src/config/surfaceModels.test.ts`); what needs a browser
is whether the scene agrees with it. Needs an unrestricted `VITE_CESIUM_ION_TOKEN`.

**Procedure.** With `?layers=ArcGis&gs=48.1372,11.5756,Munich`, walk `surface=` and
`scene=` through the combinations, reading `cc.surface.active`,
`scene.globe.show`, `scene.terrainProvider.constructor.name`, the camera's cartographic
height, and the dimmed groups in the Map panel.

**Result, 2026-07-29, Chrome.**

- `surface=OsmBuildings&scene=3D`: buildings drawn on the globe over Munich, terrain
  `CesiumTerrainProvider` while the store still holds `None`, Terrain group dimmed and
  Layers not. The Terrain radio reads `CesiumWorldTerrain` — the terrain in force, not the
  stored choice — its rows are disabled, and the note names what returns
  ("OsmBuildings needs CesiumWorldTerrain, None returns"). Re-checked 2026-07-30 after
  the radio was rebound; before that it read `None` and said nothing, which is what the
  rebinding fixed.
- `surface=GooglePhotorealistic&scene=Sky`: globe hidden, mesh drawn, both Layers and
  Terrain dimmed. The camera settled at **563.3 m** ellipsoid height at the observer —
  the mesh surface plus the 2 m eye height, where without the clamp it would have been
  2 m, i.e. some 560 m underground.
- Switching that to `scene=3D`: tileset removed, globe back, nothing dimmed, terrain
  back to `EllipsoidTerrainProvider`, `?surface=GooglePhotorealistic` still in the url,
  and the panel reads "Applies in the sky view only".
- `surface=OsmBuildings&scene=2D`: no tileset, terrain not overridden, panel reads
  "Applies in the 3D and sky views only".
- **Ground-clamped overlays under a hidden globe**: a probe corridor with
  `heightReference: CLAMP_TO_GROUND` through the observer rendered and draped onto the
  photorealistic mesh, following the street and correctly occluded by the buildings
  either side. So the Ground track component needs no suppression there.
- **Failure path**: with `VITE_CESIUM_ION_TOKEN=not-a-real-token`, selecting
  `GooglePhotorealistic` toasted "GooglePhotorealistic unavailable … Cesium ion needs a
  token valid for this origin", put the radio back to `None`, and dropped `surface`
  from the url. `SurfaceModel.apply` was called exactly twice — the attempt and the
  revert — so the failure is reported once.
- **Ground station pin**: at the Eiger with `terrain=CesiumWorldTerrain` the pin sits on
  the ridge, where at its stored height of 0 it had been ~4 km below the surface.

**Loading cost, 2026-07-30, Chrome.** Measured because "load the buildings later" turned
out to have nothing to defer: at globe altitude OSM Buildings loads _nothing_ — 0 tiles
visited, 0 ready, 0 MB — so Cesium already withholds it until the camera is near the
ground. In the sky view at Marienplatz, settled, the neighbourhood costs 34.38 MB across 34
tiles with the sky-view roll-off, against 39.73 MB across 40 tiles at Cesium's defaults:
a 13% saving from capping the radius at ~800 m. The eye sat at 573 m, i.e. ground + 2 m.

The globe's 2 km ceiling, same city, three altitudes: at 9,261 km and at 2,500 m the
tileset was hidden with 0 tiles visited and 0 MB; dropping to 1,400 m showed it and
streamed 35 tiles for 44 MB. Entering the sky view from there kept it shown with the
ground-level roll-off (density 8.0e-4, factor 48) and the eye at 573 m. Note the ceiling
is re-evaluated on `preRender`, so a camera moved from the console in a stalled render loop
will read as stuck hidden — force a frame before believing it.

**The mesh waits for the descent, 2026-07-30, Chrome.** Entering the sky view with
`surface=GooglePhotorealistic` from the default globe view: mid-flight the tileset was
present but `show: false` with **0 MB** of geometry and the globe still visible, so the
descent costs nothing and is not black. On landing, `settled: true` flipped it to
`show: true`, hid the globe, and started requests. The tileset carried
`maximumScreenSpaceError: 24`, `skipLevelOfDetail: true` and
`immediatelyLoadDesiredLevelOfDetail: true`.

The skip-LOD saving itself is **not measured** — a clean before-and-after needs an uncached
city and burns Google quota — so it is reasoned from Cesium's documented behaviour only.

The service worker is checked in the build output rather than at runtime: neither
`ion.cesium.com` nor `googleapis` appears in `dist/sw.js`, which is the property that
matters. Both providers limit the caching of their tiles.

The 1 km OSM ceiling's above-ground behaviour is **unverified here**: this environment
never refines terrain past level 0, so `globe.getHeight` returns either nothing or
implausible values (-76594 was observed) and the sticky-last-believable fallback keeps the
gate on ellipsoid height. Worth re-checking in a real browser over a high city.

Not exercised: iOS, where the photorealistic mesh's tuned-down `cacheBytes` and
`maximumScreenSpaceError` apply, and where a phone's memory is the thing being protected.

## Sky view: what a device is still needed for

Open questions 1 and 2 in `docs/adr/0003-sky-view.md` need a real phone on HTTPS —
`getUserMedia` and `DeviceOrientationEvent.requestPermission` both demand a secure
context, so `pnpm dev:host` over a LAN address cannot exercise them. Use a tunnel
or a preview deploy. Camera passthrough is not implemented.

Device orientation **is verified on iOS**: the sign of the screen-orientation
correction and the `360 - webkitCompassHeading` substitution are both right, and the
sky lines up with what the phone is pointed at with no manual trim. What remains
unverified is the Android path — `deviceorientationabsolute` — which is written
against the specification only. See `docs/adr/0004-compass-aiming.md` for why an
untested heading source is required to either work or decline.

[^basemaps]:
    `Offline` and `OfflineHighres` have since collapsed into the single `NaturalEarth`
    layer, so that list is one shorter now. What was being checked — that the radios bind
    by provider, so an `_0.5` token still reads as the layer it is — is unaffected.

## Ground station link: drawn when switched on, free when not

**Why it cannot be a unit test.** The link is one dynamic polyline Entity per
satellite, and what it costs is Cesium's per-entity update each frame. Whether it
reaches the scene is unit-tested (`SatelliteComponentCollection.test.ts`); the frame
cost and the picture are not.

**Procedure.** `pnpm build && pnpm preview`, then open
`?tags=Starlink&gs=48.1800,11.7500,Munich&elements=Point&framems=16` and,
once every satellite is active and the scene has settled, time `clock.tick()` plus
`scene.render()` from the console. Repeat with `elements=Point,Ground+station+link`,
look at Munich, and untick the link in the satellite menu.

**Result, 2026-10-04, Chrome (in-app browser pane, hidden, frame pump on), 11,152
Starlink satellites.** Link off: 18 ms a frame and no link entities, the same as
before the link was a component. Link on: 109 ms a frame, about 8 µs per satellite,
and activation about 4x slower; 281 links drawn from Munich at once. Unticking it
removed all 11,152 link entities and dropped it from `elements`.

**Result, 2026-10-04, same setup, the first 1,000 catalog names.** Measured off, on,
off in one page, each after the scene settled: `dataSourceDisplay.update` 0.5 ms with
the link off and 8 ms with it on, a frame 21 ms and 30 ms. 50 links drawn.

## Clock deck: the replacement for the animation and timeline widgets

**Why it cannot be a unit test.** Everything the deck is depends on layout. Its
surface is measured off the controls with `getBoundingClientRect`, the timeline's
scale depends on the width it measures for itself, the credit line has to clear it
without being covered or made unclickable, and both scales are pointer gestures
with inertia — jsdom answers none of that.

**Procedure.** The deck is on every device now, so no patching is needed. At any
viewport:

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

Then: tap the clock to fold and unfold (the clock and play button must not move,
and the credits must drop to Cesium's own 3 px and come back); tap the gauge to put
the ladder on the band (the deck's height must not change); swipe the ladder and let
go (it must coast and rest exactly on a rung — `scrollLeft / 64` an integer); drag
the timeline and let go (the clock pins, `?time=` appears, and the reset appears).

**Result, 2026-08-19, Chrome, 375x700 and 390x844 (with the deck still gated on
`minimalUI`, so those two runs had it forced), rechecked at 694x800 once it was on
every device.** Surface 92.5 → 317.5 against controls at 100.5 → 309.5, so both
edges exact; seam 0.0; clock centred to 0.0; credits at 98 px above the deck and
3 px when folded, clearing the folded card by 17 px; the credit logo and both links
hit-test to themselves, and `Attribution` still opens Cesium's lightbox. At 624 px
the credits move into the control row (57 px) with 10.2 px of clearance to the
surface, and at 623 they stay above the deck; at 1000 px the deck caps at 560 px and
centres and the credits return to the bottom-left corner, 9.2 px clear of it.

Both of those widths are measured off the credit container's box, which ends 5 px
past its last link: 206 px, not the 196 px of content. Sized off the content, each
breakpoint left half the intended gap at the width that triggers it. Two things
inside that line move both numbers if they change: `createViewer` shortens Cesium's
`Data attribution` to `Attribution`, and main.css draws the ion logo at 22 px rather
than its own 28. Measured at each: box 236 px with the long link and the full-size
logo, 206 with both changes.

Sky view's cards resolve to `bottom: 102px` with the deck present and 64 px without.

**Where the credit line sits is one CSS variable, in four cases.** The offsets were
literals in `useClockDeckChrome` — 98, 57, 3 — measured on a phone with no home
indicator, so on one with a notch the deck grew by `env(safe-area-inset-bottom)` and
the credit line did not: it ended up behind the scale row. The composable now sets
`body[data-clock-deck]` to the case, and main.css writes each offset in terms of
`--clock-deck-safe`. Check by reading the computed variable in each state rather
than the pixel, since the pixel is only right on a device without a notch.

**Result, 2026-08-19, Chrome, 694x800 and 1280x800.** `calc(51px + max(6px, 0px))`
beside the controls, `calc(3px + 0px)` folded and again in the desktop corner, and
`calc(var(--clock-deck-height) + 4px)` clear of the deck below 624 px.

**The ruler must measure itself against the deck it is in.** `--clock-deck-max`
lives on `:root` and not on `body.clock-deck`, because the class is added by the
deck's own `onMounted` and the timeline measures its width in that same tick: hung off
the class, the first measurement was the uncapped one and the clock's moment sat
350 px away from the needle. Check it by reading where the hour labels fall —
150 px apart, and the one before the needle no further from it than the clock is
past the hour.

**Result, 2026-08-19, Chrome, 1280x800.** Ruler 560 px, 23 ticks spanning it, hour
labels at 118.5 / 268.5 / 418.5, needle at 280, clock 21:04:48 — so 21:00 sits
11.5 px left of the needle where 4.8 minutes is 12 px. Deck centred at 360–920,
credits in the bottom-left corner 277 px clear of it, fullscreen button still
present and 331 px clear. Below the cap the scale row covers the corner that button sits
in, so it is hidden there: `display: none` at 900 px, back to `block` at 1280. The eye toggle removes the deck, the body class and the fullscreen button
together, and restores all three.

**Pass bands.** The selected satellite's passes are published to
`usePassHighlights` and drawn on the timeline, which is what Cesium's timeline
highlight ranges used to do. With no satellite data to hand, drive the seam
directly — Vite hands back the same module instance the deck imported:

```js
const mod = await import("/src/composables/usePassHighlights.ts");
const clockMs = Date.now(); // or the deck's own clock, if it has drifted
mod.setPassHighlights([{ start: clockMs + 5 * 60_000, end: clockMs + 13 * 60_000 }]);
```

**Result, 2026-08-19, Chrome, 1280x800.** A pass five minutes ahead lands 12.5 px
right of the needle and is 20 px wide, which is 8 minutes at 1 hour per 150 px; one
40 minutes behind lands 100 px left; one spanning the whole window is clipped to the
ruler rather than dropped; one ten hours out is not drawn.

**Folded, the credit line has to clear a phone's rounded corner.** At Cesium's own
5 px in and the deck's 3 px up it sits inside the curve and the logo is cut off. A
55 px corner radius intrudes about 21 px at 12 px above the bottom, so on those
screens the folded case moves the line to 24 px in and 12 px up. Only that case, and
only there: the other three placements are far enough up that the curve never reaches
them, and a square screen has nothing to avoid.

The condition is `pointer: coarse`, which is a stand-in. The safe-area insets would
say "rounded" directly, but in an iOS standalone app they are all 0 unless the
viewport is `viewport-fit=cover`, which this app does not set — measured on the iPhone
that showed the clipping, the line sat 2 px above the bottom rather than the 36 an
inset would have given it. Setting `viewport-fit=cover` would make the insets real and
is the better answer, at the cost of compensating every top-anchored control for the
status bar.

**Result, 2026-08-20, Chrome, 390x844 with touch emulation.** Deck starts folded,
credit line at left 24 and bottom 12, clearing the folded card by 8 px. With a fine
pointer at 748 px the deck starts open, and folding it by hand leaves the line at
Cesium's own 5 and 3. Breakpoints
re-measured after the logo change: 623 keeps the credits above the deck, 624 puts
them in the row with 10.8 px of clearance and the Attribution link still hit-testing
to itself, 1000 caps the deck at 560 and returns the credits to the corner 13.8 px
clear of the scale row with the fullscreen button back and 191 px clear.

**Between 448 and 623 px the credit line stacks rather than leaving the row.** As
one line the box is 201 by 25, and below 624 px it had to move above the deck. Now
the composable has a fourth case, `stacked`: the ion logo over `Privacy Attribution`,
113 by 39, which fits beside the surface down to 448 px. Its offset is 46 px so the
taller box stays centred on the controls. Only that case stacks — clear, folded and
the desktop corner keep Cesium's single line, and so does `beside` from 624 up.

**Result, 2026-09-05, Chrome, emulated 447 / 448 / 623 / 624 / 1000 px.** Clear at
447, one line 4 px above the deck; stacked at 448, box 113.4 by 39 with 10.6 px of
clearance to the surface and its centre 1.5 px above the clock's; still stacked at
623; one line beside at 624, 201 by 25 with 10.8 px of clearance; one line in the
corner at 1000. The emulated viewport does not fire `resize`, so each width was
measured after dispatching one by hand.

**The scale row and the clock's surface are one shape.** The row's top corners carry
the surface's 16 px radius, and two fillets on the row (`::before` / `::after`, placed
off the same `--surface-left` / `--surface-right` the surface is drawn from, which is
why those now live on the deck rather than the cluster) join the two. Check the
fillets by reading their computed `left` and `right`: each is the inset less 16.

**Result, 2026-09-05, Chrome, emulated 800 and 1100 px.** Fillets at `left: 239px`
against a surface at 255, row radius `16px 16px 0 0`, and the top-left pixel of the
row hit-tests to the globe where 20 px lower hits the timeline. Folded, the card is
`16px` all round and the row and its fillets are gone with it. At 1100 the capped row
is a 560 px card with the same corners and the fillets follow the surface into it.

**Still needs a real device.** The gesture feel — flick inertia, the ladder's
settle, and whether 1 hour per 150 px is the right scale for a thumb — was judged in
the prototype this deck came from, but not on iOS. Nor is the notch itself tested:
the offsets are written in terms of `env(safe-area-inset-bottom)` now rather than
around it, but no run has had a home indicator to prove it. The same goes for
rotation, where the surface is re-measured from the `resize` listener rather than
from the observer.

## Tracking: the flight lands where tracking puts the camera

**Why it cannot be a unit test.** The pose comes from Cesium's `EntityView`, and
whether the camera moves when `trackedEntity` engages is a property of the real
camera, tweens and frames. The flight bookkeeping is unit-tested
(`trackFlight.test.ts`); this is the part that is not.

**Procedure.** Open `?sats=ISS+(ZARYA),CSS+(TIANHE)&framems=16`, pause the
clock, and record the camera's world-space position (`camera.transform` applied to
`camera.position`) when `trackedEntity` is assigned and 20 frames later, across
untracked → ISS, ISS → CSS, and ISS → CSS → ISS interrupted mid-flight. Count calls
to `viewer.flyTo`, the overview fly-back. Repeat with the clock running, in 2D, and
enter the sky view mid-flight.

**Result, 2026-10-04, Chrome (in-app browser pane, frame pump on).** Clock paused:
handoffs moved the camera 1.3 mm and 8 mm with identical direction, the interrupted
chain landed once on the last satellite, and only a deliberate untrack flew back.
Clock running: paused for the flight, resumed on landing, and the camera's offset
from the satellite changed as in steady tracking (3.3–3.5 km over 20 frames). 2D
tracked instantly. Entering the sky view cancelled the flight, gave the clock back
and tracked nothing. The Track button flew, landed and wrote `track` to the url.

**Switching from a tracked satellite, 2026-10-04.** With ISS tracked among 653
satellites, clicking another satellite on the globe opened its panel and left the
camera still and ISS tracked. Its Track button then flew there. Probing the pose on
the real camera and restoring it with `setView` had teleported the camera about
11,000 km before the flight began, because `setView` reads the saved position as
world coordinates and it was relative to the tracking transform. The probe runs on a
camera of its own now: no move on the click, and none after landing across four
switches.

**Stopping, 2026-10-04.** Stopping used to fly to 2,000 km above the satellite, so a
view from 13,017 km came back at 2,421 km over wherever the satellite had got to. It
now flies back to the view tracking began from: 0 km off and the same direction after
an animated track, after ISS then CSS, after an instant track and after tracking a
ground station. Entering the sky view while tracking used to save the tracking-relative
camera position as its way back, and leaving dropped the camera onto the surface; it
now untracks first, and leaving lands 0 km from the tracked view.

## Attribution lightbox: closable on a phone

**Why it cannot be a unit test.** Whether the close button can be tapped depends on
stacking and the safe-area insets, and jsdom has neither.

**Procedure.** Run the iOS app against the change (`make run` in `ios/` loads
satvis.space; see the note below for a local page), tap `Attribution`, then tap the
close button. In a desktop browser, open the lightbox and click outside it.

**Result, 2026-10-04, iPhone 18 Pro Max simulator, iOS 27.** Before: the full-screen
lightbox sat below the toolbars and the clock deck, its title and close button under
the Dynamic Island, and nothing closed it. After: it covers the app chrome, the
title and close button start below the status bar, and the close button dismisses
it. At 1024 px wide the windowed lightbox is unchanged, covers the toolbars, and a
click outside still closes it.

**Note: the simulator blanks a launch variable named `URL`.** `SIMCTL_CHILD_URL`
arrives as `URL=` while the same value under another name arrives intact, so
`make run URL=…` loads satvis.space. This run read a temporary `SATVIS_URL` instead,
pointed at `http://[::1]:<port>/`: Vite listens on IPv6 loopback only.

## Entity info panel: once a second at any clock speed

**Why it cannot be a unit test.** The helper's timing is unit-tested
(`CesiumCallbackHelper.test.ts`); whether the panel follows it needs the real clock
and the real panel.

**Procedure.** `?framems=16`, select a LEO satellite with
`cc.viewer.selectedEntity`, then for 5 s at each speed count the frames on which the
panel's `innerText` changed. Pause, jump the clock 30 min, and check that the panel
catches up and then stays put.

**Result, 2026-10-04, Chrome (in-app browser pane, frame pump on), CYGFM04.** Before:
5 changes in 311 frames at 1×, 310 in 311 at 3600×. After: 5 changes at 1×, 60×,
3600× and 86400×, none while paused. After the jump the panel had updated within
200 ms and did not change again while paused.

## Render on demand: a paused clock draws nothing

**Why it cannot be a unit test.** Whether a frame is drawn is Cesium's decision in
`Scene.render`, against a real clock and real entities.

**Procedure.** Open
`?elements=Point,Label,Orbit,Orbit+track,Ground+track,Sensor+cone,Ground+station+link&gs=48.1371,11.5754&framems=16`,
wait for the globe's tiles to load, then count `scene.postRender` and `clock.onTick`
events for 5 s running and 5 s paused. Not with `bench=true`: the benchmark panel
turns `requestRenderMode` off.

**Result, 2026-10-04, Chrome (in-app browser pane, frame pump on), 72 satellites.**
Running: 113 renders in 309 ticks. Paused: 0 renders in 310 ticks, with the sensor cone
and ground station link (the `CallbackProperty` users) on. Rerun with `?framems=16`
and no panel: 115 and 0, `requestRenderMode` on throughout.

## Orbit batch: the line passes through the satellite

**Why it cannot be a unit test.** The unit test pins the ICRF transform to identity; the
gap that matters is in the fixed frame, with the real rotation.

**Procedure.** `?tags=&sats=ISS+(ZARYA),NOAA+20+(JPSS-1)&elements=Point,Orbit&framems=16`.
For starts across one sampling interval, rotate the batch's orbit with
`computeIcrfToFixedMatrix(t)` over the next quarter period and take the satellite's
distance to the nearest segment. For cost, time `positionsForNextOrbit` over
`?tags=Starlink`.

**Result, 2026-10-05, Chrome (in-app browser pane, frame pump on).** Worst gap: ISS
5.9 → 2.3 km, NOAA 20 7.1 → 2.5 km; the rest is the chord between samples. 11,146
orbits: +21 ms per full rebuild, against 1.4 s on the main thread for the rebuild itself.
