# Native app: manual verification

What the native app's tests cannot check (`ios/`), rerun when the code it covers
changes, with what each run returned. The web app's checks are its e2e suite.

## Native app: Re:Earth terrain, and what it asks of Re:Earth

**Procedure.** In the iPhone 17e simulator (3× screen), with the Map panel's
VersaTiles and Terrain on and `SATVIS_TIME=2026-10-04T09:30:00Z` for daylight, put a
ground station on the Zugspitze (47.4211, 10.9853), follow it from its panel, and pinch
in until the tracking camera stops. Count the requests from the app's log
(`log show --predicate 'process == "satvis" AND subsystem BEGINSWITH "com.apple.CFNetwork"'`)
and watch the `imagery` category for failures.

**Result, 2026-10-04.** The Wetterstein and Karwendel stood up in relief, lit from the
south-east by the terrain's own normals, with sharp VersaTiles imagery on them and no
cracks at tile edges. The settled view drew about 170 surface tiles, levels 8 to 13, over
66 terrain tiles. The first build asked for terrain at each surface tile's own level:
about 400 terrain tiles to zoom to 500 km over the Sahara, after which Re:Earth answered
429 and the globe stuck at a coarse level. Taking the terrain two levels coarser (the
level CesiumJS would ask for) brought that zoom down to 38 terrain tiles with no failures.

Two more defects showed only in this low, oblique view, and are fixed. Tiles in use were
being evicted once the view needed more than the 384-texture budget, so the surface
collapsed to one level-2 tile every ten seconds and refined again. And tiles whose
mountains rose into the bottom of the view from below its edge were culled on their flat
bounding sphere, leaving a jagged black band along the bottom of the screen.

VersaTiles answers 404 for a few level-13 tiles in the Alps (`13/4456/2896`–`2898`);
their level-12 ancestor stands in.

## Native app: the attribution follows the map

**Procedure.** With VersaTiles and Terrain on, tap "Attribution" above the clock deck,
read the list, and open Privacy.

**Result, 2026-10-04, iPhone 17e simulator.** Map: Natural Earth, VersaTiles sources,
Re:Earth Terrain · Mapterhorn (CC BY 4.0), then Mapterhorn, EGM2008 (NGA), Protomaps and
OpenStreetMap, as Re:Earth's `layer.json` credits them that day. Satellites: "Satellite TLE
data provided by Celestrak". Privacy opened `satvis.space/data/privacy.html` in Safari,
which redirects to the Legal Notice & Privacy page.

## Native app: the sky view

**Procedure.** In the iPhone 17e simulator, open the about page's sky link through
`SATVIS_LINK` with `SATVIS_TIME=2026-10-04T19:22:00Z`; then, from the globe, open a
station's panel and its binoculars, and leave by the globe button. Drag the view, pinch
it, put a satellite under the crosshair and tap; switch on the compass.

**Result, 2026-10-04.** The link stands in the Lauterbrunnen valley at night, the
cliffs on either side and the geostationary belt to the south at about 33°, the tapes
reading 165°–S–195° and 0° to 45°. The crosshair took METEOSAT-11 (MSG-4) 35 points
off centre and its card read elevation 33.0°, azimuth 177.9° S, range 38,336 km and
altitude 35,786 km; a geostationary satellite seen from 46.6° N. On the Zugspitze
station the eye stood over the Zugspitzplatt with the ridges around it and never
under the ground. The flight out showed, in order, the sky, the Alps from above, the
globe's limb swinging past and the globe camera. The compass answered "This device has
no motion sensor to aim with": the simulator has none, so aiming itself, its drag
hand-back and its levelling still need a device. The ground at night is lit as by
day, as CesiumJS's lighting fades out near the ground and the web's does the same.

## Native app: labels, pins, the twist and the clock deck

**Procedure.** In the iPhone 17e simulator, on the default view with the stored
station: compare the labels near the globe's limb with satvis.space at 390 × 844; twist
clockwise with two fingers; open the clock deck, switch to the ladder, take a rung and
come back.

**Result, 2026-10-05.** Labels overhanging the globe draw whole over it, as on the web,
and a satellite behind the Earth takes its label with it; METEOR-M2 and MAKERSAT no
longer throw spikes off their M. The pin, the web's own, stands about 15 points tall at the
default height, its tip on the station; the toolbar carries the web's Lucide icons. A clockwise twist turned north from the top of the screen to the right. The
deck matches the web's: the clock on the amber needle, the white play disc to its left,
the scale chip to its right and the amber reset after it, the tab widening to take it,
over a full-width row running down to the bottom edge with the ticks rising from the
bottom; the ladder settles on a rung with its rate under it. Folded, the clock stays
where it was. "Attribution" stands at the left end of the control row, beside the tab
open or folded, and opens its sheet.

## Native app: the tool menu

**Procedure.** In the iPhone 17e simulator, record the screen while
`testOpensTheToolsFromTheMenu` taps the burger, and step through the frames.

**Result, 2026-10-05.** The burger turns to the close cross from one frame to the next,
never both at once. Satellites, Components, Ground stations and Map materialise in the
same frames, each a 62 × 52 pt glass button like the burger's with its name on a glass
capsule beside it, legible over the globe and over space; the two menus' glass is
drawn with the buttons', where the system's arrived a beat later.

## Native app: performance and the sky view's instruments

**Procedure.** Release build in the iPhone 17e simulator, `SATVIS_API=https://satvis.space`
(which counts nothing), each link opened and left 30 s to load, then the app's CPU
sampled once a second for 20 s and a 10 s Time Profiler trace taken.

**Result, 2026-10-05.** The default view used 8% of a Mac core. 16,000 satellites (`tags=Active`)
as points used 16–18%, with a 256 MB footprint, about 1.5 ms of main-thread work a
frame and 3 s of multi-core work to build them; with orbits, 17%; Starlink with
ground tracks, 11%. The sky view over the same 16,000 used 58%, two thirds of it
the instruments: every satellite placed each frame for the crosshair, and the
terrain walked for it and its path. Working the lock out fifteen times a second,
keeping the ground's answers and putting the path on a 30 s grid brought it to
24%, the instruments to about 6%; the lock on METEOSAT-11 over Lauterbrunnen read
as before, 33.0° and 177.9° S. The performance overlay showed 60 fps, CPU 9.3 ms
in a Debug build, GPU 0.2 ms, 16,633 satellites and 256 MB. The simulator's
figures are relative only; the phone's need a device.

## Native app: terrain under Natural Earth

**Procedure.** In the iPhone 17e simulator, open the Lauterbrunnen sky view
(`scene=Sky&gs=46.5935,7.9091`) on the default Natural Earth base map, with `fps=true`.

**Result, 2026-10-05.** Before, the ground was a flat green band: the surface stopped
refining at Natural Earth's level 6, and the terrain under it was level 4, a grid
20 km apart. With the surface refining to the terrain's level whenever terrain is
on, the valley's cliffs stand either side as they do on VersaTiles, Natural Earth
magnified over them, at 60 fps and 3.1 ms of CPU a frame in a Debug build; the lock
on METEOSAT-11 read 33.0° and 177.9° S as before.

## Native app: passes for a new ground station

**Procedure.** Debug build in the iPhone 17e simulator on `tags=Active&elements=Point`
(16,629 satellites), then Ground stations → Pick on globe → a tap on the globe, timed by a
UI test from the tap until "Computing passes…" goes.

**Result, 2026-10-05.** Before, 136 s with two saved stations and 187 s with three, the
panel blank throughout: every satellite was predicted over every station. With a
station's panel predicted over its own station alone and the passes listed as they come,
the first passes showed after 4.5 s and the last of the 16,629 after 42 s, the count of
satellites done climbing beside them. The default view's 72 satellites took about 2 s,
most of it the prediction loop's one-second pause.

## Native app: picking a satellite by its name, and the way home

**Procedure.** In the iPhone 17e simulator on the default view, tap the end of a
satellite's name, well away from its point. Then drag the globe away and tap the globe
button under Share.

**Result, 2026-10-05.** Before, only the point answered a tap, within 24 pt, so a tap on
a name more than that from its point picked nothing. A tap 84 pt along SENTINEL-3B's name
opened its panel. The globe button flew the camera from over the Arctic back to the
home view above 25° N 15° E in 1.5 s; in the sky view the same button leaves it.

## Native app: orbit lines one point wide, edges smoothed

**Procedure.** In the iPhone 17e simulator, open `?tags=Weather&elements=Point,Label,Orbit,Orbit+track`
and look at a 3× crop of the lines over the globe.

**Result, 2026-10-06.** The orbits and orbit tracks are one point wide, as the web app's
1 px since 5dcc6b1, and their edges fade over a device pixel with no stair steps, where
the web app now runs FXAA (ac4fdc3). The white and gold at 15 % still read over Natural
Earth's land and sea. The globe's limb against space is still a hard edge: only a full-frame
pass would smooth it.

Since 2026-10-26 the web app no longer relies on FXAA for its batched orbit lines: they
are one CSS pixel wide with their edges faded over a device pixel, as here, at 22.5 %.

## Native app: a link that names a component keeps it over its budget

**Procedure.** Debug build in the iPhone 17e simulator against satvis.space, by a UI
test that opens a link, waits 25 s for Starlink to load, then reads the Label switch in
Menu → Satellite components. Once with `?tags=Starlink&elements=Point,Label`, once with
`?tags=Starlink`.

**Result, 2026-10-06.** With `elements` naming it, Label stayed on through the crossing
of 200, with the note that labels show for up to 200 satellites. Without it, Label
switched off and the note was gone, as on the web since 971e415.

## Native app: flying into tracking, and home from it

**Procedure.** In the iPhone 17e simulator on the default view, select FENGYUN 3A, tap
Track in its panel, then the globe button, capturing the screen as fast as `simctl io`
allows (a frame every 0.4 s or so).

**Result, 2026-10-06.** Track flew from the home view to the tracking view over the
satellite, a frame in between showing the globe turning, as the web app's Track button has
since bf576a0; the clock ran on, since the flight heads for where the satellite is each
frame rather than where it was. The globe button flew from the tracking view straight back
to the home view, with no cut to the view tracking began from on the way.

## Native app: 3D models

**Procedure.** In the iPhone 17e simulator, open the about page's ISS view
(`?tags=&sats=ISS+(ZARYA)&track=ISS+(ZARYA)&elements=Point,Label,Orbit,3D+model&layers=VersaTiles&time=2026-10-04T02:07Z`)
and close the info panel. Then the same link without `track`, from the home view. In a
scratch test, read every file in `data/models/public` with `ModelAsset`.

**Result, 2026-10-06.** All ten models read, with the triangle counts and dimensions
`models.yaml` records, in up to 0.5 s each in a Debug build, off the main thread. The ISS
was fetched from satvis.space and drawn with its truss across the ground track and its
arrays lit by the sun. From the home view it held the web app's 72 points, its point
hidden and its label moved past its edge. Tracked, the camera opened six model
radii off, south-east and above, as the web app frames a model, once the model had
loaded; the point was hidden, and the label too, being nearer than 2 km.

## Native app: the benchmark on an iPad mini

**Procedure.** Release build, development-signed, on an iPad mini (6th generation,
`iPad14,1`, iOS 27.0.1, 60 Hz, drawn at 2266×1488), run with `SATVIS_BENCHMARK=1`
through `xcrun devicectl device process launch --console`, the report read from its
output. The same scenes were first measured by hand with Instruments' Metal System
Trace and Time Profiler.

**Result, 2026-10-06.** Everything held 60 fps but two scenes. All active satellites
with orbits ran at 26.6 fps on 43.5 ms of GPU a frame: 16,630 orbits of 121 nodes, each
node worked out three times. The ISS model tracked close up ran at 40 fps on 12 to 13 ms
of GPU, frames alternating between 16.7 and 33.3 ms, but only with its info panel open,
which the tracking link opens: the panel's glass over the half of the screen it covers.
With the panel closed, as the benchmark leaves it, the scene held 60 fps on 9.2 ms. Every scene carried
about 9 ms of GPU before a satellite was drawn: the tonemap pass 2.1, the star background
2.0, the globe's 51 tiles 1.9, the sky atmosphere 1.7. On the CPU, 41% of all time with
16,630 satellites was `SampledTrajectory.stencil(at:)`, 3.4 ms of the main thread's 4.3 a
frame, reading each satellite's own array to check its nodes. Memory reached 650 MB in the
sky view. The first scene repeated at the end drifted 0%, the device nominal throughout.
The glass panel itself cost about 2 ms of GPU a frame (11.3 against 9.2 ms in the default
view); without the glass while measuring, 10.5.

## Native app: the pixel ratio, and the panel open while tracking

Superseded in part: the scene with the panel open is gone from the benchmark (ADR 0016),
as a `track=` link opens no panel. The pixel ratio findings stand.

**Procedure.** Release build on the iPad mini (`iPad14,1`, 60 Hz), the benchmark run with
`SATVIS_BENCHMARK=print` over the default view, all orbits and the ISS tracked with its
panel open, launched on `?pixelratio=native`, `1.5` and `1`. Then screenshots of
`?elements=Point,Label,Orbit` at native and at 1.5.

**Result, 2026-10-06.** The tracked ISS with its panel open, 40 to 44 fps at native, held
60 fps at 1.5 (8.8 ms of GPU) and at 1 (5.7 ms). The default view took 10.5 ms of GPU at
native, 6.7 at 1.5 and 2.8 at 1 (2266×1488, 1700×1116 and 1133×744 drawables). All
orbits stayed near 30 fps at every ratio, their cost being vertices, not pixels. Points,
labels, pins and lines kept their size at 1.5; the picture was a little softer and the
map a level coarser.

Before, the panel's 40 fps was not its glass: an opaque panel and an empty inspector ran at
40 fps too. An inspector column narrows the globe's view, and frames then missed every
other refresh; a card over the full-screen globe ran at 40 to 54 fps, our 9 to 11 ms of GPU
a frame and the compositor's 7 to 8 ms a refresh leaving no margin.

## Native app: fast math, tiles relative to their centres, and the stencils off the main actor

**Procedure.** Release build on the iPad mini (`iPad14,1`, 60 Hz, native pixel ratio), the
benchmark with `SATVIS_BENCHMARK=print` over the default view, all active satellites as
points, every component on Weather, the ISS tracked with and without its panel, and the sky
view; temporary switches skipped one pass at a time. Then screenshots of the sky view at
Lauterbrunnen and of the ISS tracked over VersaTiles and Re:Earth terrain.

**Result, 2026-10-06.** The shaders had been compiled with safe math for the sake of the
high/low subtraction a few vertex functions need. With nothing but the stars on, the frame
took 7.9 ms of GPU; with fast math, 1.6. Fragment functions on fast math brought the default
view from 11.2 to 8.5 ms. The atmosphere's per-vertex scattering, safe, cost another 2.8 ms:
the sky shell needs no split and took fast math as it was, and the globe's tiles, drawn
relative to their centres with the centre offset from the eye in double precision, took it
too. The default view then took 5.6 ms, all active satellites 4.2, the sky view 8.6, and the
ISS tracked with its panel open held 60 fps at 7.5 ms, where it ran at 40 to 44 fps. The
explicit `fast::exp` in the scattering of a safe library had changed nothing. Neither view
showed cracks or jitter, the sky view's camera 2 m over the terrain.

With 16,630 satellites the renderer's main-thread work fell from 3.6 to 1.0 ms a frame.
Finding each satellite's stencil had been 41% of all CPU time: the loop ran inside the main
actor's isolation, and Swift checked on every turn that it was on the main actor, 1.3 ms a
frame; reading each trajectory for its refused nodes was the rest. The stencils are now
found off the actor from one packed array, and a trajectory is read only when it has a
refused node.

## Native app: the globe's limb, and the sky atmosphere as a ring

**Procedure.** The default view at a pinned instant (`SATVIS_TIME`) on the iPhone 17e
simulator and the iPad mini (`iPad14,1`, Release), screenshots of the limb compared
pixel by pixel between commits and variants, at 12:00 and 17:30 UTC; then the benchmark
with `SATVIS_BENCHMARK=print` on the iPad, each variant against the same build's HEAD.

**Result, 2026-10-06.** The limb had not changed since the tile meshes came in: every
commit back to the benchmark panel drew it pixel for pixel the same, on both. The bumps
along it were the sky atmosphere's 128 by 64 shell, coloured per vertex: where the eye's
ray grazes the shell its colour changes faster than one facet can follow. Computing the
ground atmosphere per fragment, as CesiumJS does past the night fade, changed 20 pixels.
A 256 by 256 shell, CesiumJS's, was smooth but took the default view from 5.8 to 9.2 ms
of GPU a frame, and skipping the scattering at the vertices no pixel shows saved 0.4 of
that. Colouring the shell per fragment was smooth too and cost 1.1 ms in fragments, the
depth test and a ray test for the globe's pixels saving nothing. 4× MSAA smoothed the
rim's remaining steps for 0.8 to 2.7 ms and was dropped, as the web app drops MSAA at a
ratio of 2. The ring, from more than 10 % outside the shell, is as smooth as the 256 by
256 shell; the default view took 5.4 ms, HEAD 5.3 to 5.8, and the sky view and the ISS
tracked, which keep the whole shell, did not change.

## Native app: every active satellite's orbit

**Procedure.** Release build on the iPad mini, the benchmark's `active_orbits` scene
(16,626 satellites, an orbit of 121 nodes each) with temporary switches; a Metal System
Trace of the same view; then the simulator's Weather group with orbits and orbit tracks,
and the sky view with orbits, compared pixel by pixel with HEAD.

**Result, 2026-10-06.** The scene ran at 26.9 fps on 60.5 ms of GPU a frame. With the
lines given no width it took 14.5 ms, and leaving out the neighbouring nodes and the
Earth's turn from the vertex function changed nothing, so the vertex work was not the
cost. Opaque lines took 49 ms, and gamma-correcting once per line rather than per pixel,
the colour out of the vertex outputs and a quad no wider than its fade together took 4.
The trace put 24.6 ms of the frame before the fragments, sorting 4 million triangles into
tiles. With no width where a node and its neighbours are behind the Earth, the scene ran at
39.9 fps on 29.4 ms; the Weather view and the sky view drew the same pixels as HEAD. The
other scenes: default view 5.4 ms, Starlink 7.4, all active as points 8.1, Weather 7.5, the
ISS tracked 6.8 and with its panel 7.2, the sky view 8.8, all at 60 fps.

## Native app: the orbit closed into a loop, and main's new models

**Procedure.** The ISS alone with its orbit on the iPhone 17e simulator, at 12:25 UTC,
when the far side of its orbit crosses the globe, compared pixel by pixel with the build
before; the benchmark's `active_orbits` and `weather_all_components` on the iPad mini.
Then Suomi NPP, GOES 18, CYGFM03 and TDRS 12 tracked with their 3D models, the panel
closed, against the site's models.

**Result, 2026-10-06.** The line's two ends had missed by the orbit's drift over a
period, about 2 px at the default view; they now meet, and only the quarter behind the
satellite moved, by up to 51 levels at the seam and less along the ramp. All active
satellites' orbits ran at 39.7 fps on 32.1 ms of GPU, against 39.9 on 29.4 before; Weather
held 60 at 7.3 ms. All four models loaded and drew with their textures, TDRS 12's mesh
antennas too.

## Native app: the web app's menu column, and the attribution link

**Procedure.** The iPhone 17e simulator, a temporary UI test holding each menu open for
screenshots: the column, Map, View, Graphics and the Attribution sheet; then the iPad Pro
13-inch (M5) simulator at launch.

**Result, 2026-10-06.** The column reads Menu, Satellites, Components, Ground station,
Map, View, Graphics, with the web app's icons, folded on the phone and open on the iPad.
Map lists Basemap and Terrain (None, ReEarth), View lists View mode (3D, Sky), and
Graphics lists Measurement (FPS, Benchmark) and Pixel ratio, each under its title and in
the web's order: an inline Picker in a menu had dropped its section's title, and a menu
opening upwards had reversed its items until `menuOrder(.fixed)`. The Attribution link
had taken no taps, at HEAD too: folded, the deck's left column held only a spacer and
left the link 35 by 8 pt. With the column the row's height it is 56 by 44 pt, and the
sheet opens, "Share usage data" beside the privacy policy, disabled in a debug build.

The UI tests on the iPad mini (`iPad14,1`), UI Automation enabled: 9 passed and the 3
screenshot tests skipped, once the tests opened the column only where it is folded; they
had assumed a phone's folded column and failed on the iPad's open one. On the iPhone 17e
simulator, the same 9 passed.

## Native app: the menu column's panels

**Procedure.** The iPhone 17e and iPad Pro 13-inch (M5) simulators, a temporary UI test
opening Components, Map, View and Graphics in turn for screenshots; the column's open and
close recorded with `simctl io recordVideo` and read frame by frame.

**Result, 2026-10-07.** Each opens a panel beside the column: its title and close button
over a rule level with the column's, switches for the components and the measurements, a
segmented control for Terrain and View mode, ticked rows for Basemap and Pixel ratio, the
entry cyan while its panel is open. On the phone the column folds to its icons and the
panel runs to the margin over Share and the globe button; beside them at 280 pt, they had
peeked out past it. On the iPad the names stay. The column opens and closes in about 0.2 s,
the rows uncovered by the growing panel rather than showing ahead of it.

**Result, 2026-11-09.** Graphics, regrouped as the web app's: Hide UI, FPS and Benchmark
on one card with no title, a hairline between each two, then Frame rate and Pixel ratio,
each a segmented control under its title, with no notes. Pixel ratio reads 1x, 2x, 3x
on an iPhone 18 Pro simulator, its middle rung halfway to the screen's own, and
fits at the XXL text size. 2x took a tap and the globe drew on. The whole panel shows
without scrolling. The UI tests that open it (Hide UI, FPS, Benchmark) passed. Opened
on `/?pixelratio=1.3`, the globe drew soft and Pixel ratio read 1x, 1,3x, 2x, 3x with
1,3x picked (a German simulator); picking 2x dropped the 1,3x segment and sharpened the
globe. Checked on the iPhone 18 Pro only, not the iPhone 17e or the iPad.

## Native app: the Sky panel, and dimming what cannot be seen

**Procedure.** A never-used iPhone 18 Pro simulator on iOS 27, opened on
`/?gs=48.1372,11.5756,Munich&scene=Sky&elements=Point,Label` with
`SATVIS_TIME=2026-10-05T17:45:00Z`, the sun about 9° down in Munich; then a temporary UI
test opening the menu and the Sky panel on the globe and again after picking Munich.

**Result, 2026-10-08.** The column reads Menu, Satellites, Components, Map, Locations,
Globe, Sky, Graphics. On the globe the Sky panel lists the two locations with the first ticked,
My location under them, Look up off, and Use compass and Out of sight dimmed and
disabled. Picking Munich flew into the sky view and turned Look up on. After dusk the
geostationary satellites to the south were drawn dimmed, their labels too, and the crosshair
on METEOSAT-11 gave its card in the web's order, azimuth first, ending "Too far". Not
checked: the compass, which needs a device, and a dimmed 3D model, the ISS not overhead
at that minute.

Then the same link with `camera=Inertial`, the Globe panel opened from the sky view and
3D picked. In the sky view 3D was unticked, under "In the sky view. Pick 3D to return to
the globe.", and the Camera control dimmed with Inertial chosen; picking 3D flew back to
the globe with 3D ticked and Inertial still chosen, now enabled. The sky card lists
Azimuth, Elevation, Range, Altitude and Visibility a row each, the values right-aligned.
Not checked by eye: the Earth turning under the inertial camera, 15° an hour at the
real-time clock; `InertialCameraTests` holds the camera still against TEME.

## Native app: bookmarks

**Procedure.** A never-used iPhone 18 Pro simulator on iOS 27, the test catalog, a temporary
UI test opened on `/?tags=&sats=METOP-B,METOP-C&elements=Point,Label,Orbit&time=2026-10-05T17:45Z`
with the site pointed at a local server of the web app's `public/`, so the demos' pictures
load; the Bookmarks sheet opened after 15 s on Recent, Demos, and after Save this view.

**Result, 2026-10-08.** The column leads with Bookmarks. Recent held the link, pictured
from the renderer's frame with its orbits, "5 Oct, 17:45 UTC" on the picture and "just
now" over it, outlined as the scene on screen; the demos showed the site's three showcase
pictures with "● Live". Save this view moved it to Saved, opened its name, and turned the
button to Saved. `testSavesAndReopensABookmark` then names it, returns to the default view
and opens it again. In that test a tap on the name's Save after typing left the alert up,
where the same tap without typing closed it and return saved the name; not checked by
hand. satvis.space answers 404 for `showcase/` until main is deployed, so the demos show
no picture before then.

## Native app: the branch review's fixes

**Procedure.** A never-used iPhone 18 Pro simulator on iOS 27, the test catalog, the UI
tests these touch, and a temporary one opening Bookmarks twice: first with the site at a
local server of the web app's `public/`, then at a worker that does not answer.

**Result, 2026-10-08.** The demos' pictures fetched on the first launch showed on the
second, with no site to ask. A saved card shows a "…" that opens Rename and Delete, as
the long press does. The Sky panel holds Look up alone over its note; with the
simulator's location set to Innsbruck and the permission granted, Look up stood there
and back. All seven UI tests passed: the menu column, a tap on the globe, a link, the
Globe panel, bookmarks and Look up from the device. Not checked: a delete's Undo by eye,
and Look up on a device.

## Native app: My location and Look up keep one Geolocation station first

**Procedure.** An erased iPhone 18 Pro simulator on iOS 27, `testLooksUpFromWhereTheDeviceIs`
run three times, with the simulator's location at Innsbruck and the prompt answered by
the test; the switch's handler and the sky view's entry and exit logged meanwhile.

**Result, 2026-10-08.** Look up stood at Innsbruck, and Locations then listed Geolocation
first. Touches soon after the location prompt were lost: the Look up switch, tapped
to leave, never called its handler, in every run, while a later tap did; one run of
four lost two. The test flips the switch up to three times. Not checked: whether a
device loses them too, which would leave a user's first taps after allowing the
location unanswered.


## Native app: the smoothed flight into the sky view

**Procedure.** The iPhone 17e simulator on iOS 27, the globe north up, then the Sky over
Lauterbrunnen demo opened from Bookmarks; the flight recorded with `simctl io
recordVideo` and read a quarter of a second at a time.

**Result, 2026-10-09.** The view locked on to the valley, the map turned round under
the camera on the way down rather than rolling over, the camera came down to standing
height overhead and the view rose to the south. No frame jumped. The package tests hold
the rest: under 300°/s throughout, under 25 e-folds of height a second.

## Native app: a tracked satellite close up

**Procedure.** The iPhone 17e simulator on iOS 27, `?tags=&sats=SENTINEL-2A&track=SENTINEL-2A`
with Point, Label, Orbit, Orbit track and Sensor cone, pinched in to about 740 m and
then about 80 m; at 80 m, ten frames 0.1 s apart cropped around the point.

**Result, 2026-10-09.** Before the fix both lines left the screen from a few kilometres
in, their chords passing 2 km under the satellite, and the segment by the satellite was
dropped once the sample behind it was behind the eye. After it both lines run through
the point at either range, and the point holds the same pixel in all ten frames, with
the cone's apex and the lines on it. Not checked by eye: the shaking before the fix,
which the float arithmetic predicts at metres.

## Native app: the corner's buttons, Share in Bookmarks and About in the menu

Replaces the Attribution link of "the attribution follows the map" and "the web app's
menu column, and the attribution link".

**Procedure.** The iPhone 17e and the iPad Pro 11-inch (M5) simulators on iOS 27:
Bookmarks' Share, a card's "…" and its Share, Copy from the share sheet and the
pasteboard read with `simctl pbinfo`; About from the menu, scrolled to its foot, and its
Acknowledgements; the same link with Terrain on, and off.

**Result, 2026-10-09.** The corner holds the home button alone on the globe, and the
compass besides in the sky view. The share sheet shows the site's preview and copies a
URL. On the iPad the popover first pointed at the window's corner; anchored to the sheet
it points at the button, and a card's at its card. About ends with Privacy, Share usage
data (disabled in a debug build) and Acknowledgements: Map, Satellites, Data and
Software. With Terrain on, "© OpenStreetMap" stood left of the clock deck at launch and
was gone five seconds on; without it, nothing stood there. Not checked: the credit on a
cold launch over a slow network, where its five seconds can pass before the terrain is
drawn.

## Native app: the sky view's card

**Procedure.** The iPhone 17e and the iPad Pro 11-inch (M5) simulators on iOS 27, the
Lauterbrunnen sky with `tags=Active` at `SATVIS_TIME=2026-10-04T19:22:00Z`, the crosshair
on STARLINK-35803.

**Result, 2026-10-09.** On the phone the card holds four lines, the facts two a row and
"Tap to open" beside the name, 300 points wide inside its padding; on the iPad the web
app's seven, 230 points wide. Not checked: a Plus or Pro Max iPhone in landscape, which
reports a regular width and so gets the iPad's card.

## Native app: the frame rate

**Procedure.** The iPhone 17e and iPad Pro 11-inch (M5) simulators on iOS 27, the
Graphics panel with FPS on.

**Result, 2026-10-09.** Both offer 30 and 60 fps, the simulator reporting 60 Hz for
every device it models; at 30 the readout settled at 30 fps. Not checked: 120 fps,
which needs a ProMotion device.

**Procedure, 120 fps.** A Release build on an iPhone 16 Pro, the rate preset from
the launch arguments, as a key in `UserDefaults`' argument domain, and the
benchmark run at once: `xcrun devicectl device process launch --console
--environment-variables '{"SATVIS_BENCHMARK":"print","SATVIS_LINK":"/?bench=true"}'
-- org.frcy.app.satvis -frameRate '<integer>120</integer>'`.

**Result, 2026-10-25.** With the key `CADisableMinimumFrameDuration` the default view
held exactly 60 fps (`app_frame_rate` 120, `device_max_fps` 120); with
`CADisableMinimumFrameDurationOnPhone`, 120 fps at 2.2 ms of GPU a frame, and every
active satellite's orbit 89 fps with the GPU busy throughout.

## Native app: the iPhone Duo, closed and open

**Procedure.** The iPhone Duo simulator on its own iOS 27.2 runtime, closed and opened
with `make fold` and `make unfold`: the UI tests on one Duo closed and another open, and
on the iPhone 18 Pro and iPad Pro 13-inch (M5); the default view on the test catalog,
launched closed, then opened and closed again under the running app, each display taken
with `simctl io screenshot --display primary` (the cover) or `primary-1` (the inner one).

**Result, 2026-10-30.** Closed, the app fills the cover display's 466 by 678 pt, its
buttons clear of the status bar's column on the right and the column folded; open, the
inner display's 951 by 669 pt lying down, a regular width, the column open as on an iPad.
Opening under the running app opens the column, and closing folds it again. The UI tests
passed on all four (the Duo open skips the phone's sheet test, as the iPad does) once
they went by size class rather than idiom, and after three fixes. Closed, the Satellites
sheet keeps its search field in a Search button at its foot; the tap on the globe had
landed in the Components panel on the shorter screen. Open, the benchmark panel's twelve
rows ran 45 pt off the top until its table scrolled, and XCTest's app-wide swipes and
coordinate taps and `XCUIScreen.main` reached the dark cover display. `make screenshots`
took the three shots on all five simulators, the Duo closed at 1398 by 2034 and open at
2853 by 2007, its picture on the second screen turned upright; a first run had stopped
when the iPhone 18 Pro's app never launched, with no crash report, and the next passed.
Not checked: the upload to App Store Connect; the sky view's compass, which turns the
device's attitude by the interface orientation and needs a device; Split View; the Duo
half open.

## Native app: Satellites beside the menu column on an iPad

**Procedure.** An iPad Air 11-inch (M4) simulator (820 by 1180 pt) and an iPhone 18 Pro,
both iOS 27.2, on the live site with `SATVIS_TIME=2026-10-04T08:52:00Z`: a temporary UI
test opening Satellites, expanding Eutelsat, opening its first satellite's info, and
searching "ISS", a screenshot after each, before and after the change.

**Result, 2026-11-01.** On the iPad Satellites opens beside the column as Components does,
320 pt wide and clear of the corner, the entry cyan, the globe beside it undimmed: the
search field under the title, the groups' rows as the sheet's at the panels' 15 pt, and
under them the count and a red Clear all, the panel running down to a gap above the clock
deck and the list scrolling inside it. The sheet had sat in the middle, dimming the globe
and the column. At 320 pt a long name such as EUTELSAT 115 WEST B takes two lines, as it
does in the phone's sheet. A satellite's info button opens the card in the top-right
corner and closes the panel. A search lists its results with their groups; the
on-screen keyboard covers the panel's foot while it is up, as it does every panel's. The
iPhone's sheet is unchanged. Bookmarks and About are still centred sheets on the iPad.
The UI tests passed on both; `testEditsLocationsInTheirPanel` failed once on the iPhone
in the full run (the drag did not move Probeburg) and passed twice alone.

## Native app: the globe menu, held open with a finger

**Procedure.** The iPhone 17e and iPad mini (A20 Pro) simulators, iOS 27.2, on the live
site with `gs=48.1372,11.5756,Munich`: a finger held 0.6 s and 1 s on the globe, on the
Munich pin, and in the sky view; held 0.7 s and then dragged 150 pt; two fingers held
0.8 s; a pinch; a drag and a tap after a hold; `testPlacesAndRemovesAStationFromTheGlobe`
and the whole UI suite.

**Result, 2026-11-03.** A held finger opens a popover pointing at it, headed by the
place's coordinates in the region's format (19,43°, 4,07° in a German region), with Add
ground station here and Look up from here; on a pin, the station's name, Look up from
here and a red Remove ground station. Add placed the pin under the finger and opened the
station's panel, as Pick on globe does; Look up flew into the sky view standing there;
Remove took the pin away, its heading kept as the popover faded. The open Components
panel stayed open under it. Three faults found and fixed on the way: anchored on the
globe view, the arrow pointed 45 pt (the safe area's inset) below the finger; dragged on
after the hold, the finger turned the globe out from under the menu; and the hold was
told by `SpatialEventGesture`'s event id, the same for every touch, so after the first
hold every later tap on the globe was dropped. Lifted at 0.6 s, SwiftUI still reports a
tap, which closed the panel until the held touch's tap was dropped; at 1 s it reports
none. Nothing opens in the sky view, where a finger resting 0.7 s and then dragged still
aims the view, nor for two fingers held still; a pinch still zooms. Through the
simulator tool, the first tap outside the popover after a long press was sometimes not
delivered and it stayed open; XCUITest's taps closed it every time. The whole UI suite passed on the iPhone 17e (32
tests, 4 skipped), and the new test and the menu's tap test on the iPad mini. On the 2D
map, a hold opens the menu and Add places a station (`testAddsAStationFromTheMap`). Not
checked: a device, the haptic as it opens, a pointer's click and hold on an iPad, and a
second touch within the ~0.3 s after a 0.6 s hold lifts, while SwiftUI waits on a double
tap: it clears the hold before the held touch's tap is reported, which may then select or
close the panel. XCUITest waits for the app to idle before each tap and came 1.5 s late.

## Native app: the launch animation

**Procedure.** An iPhone 18 Pro simulator that never had the app, iOS 27.2, on the live
site: the app launched twice with `simctl io recordVideo` running and the second launch
read a frame every 0.1 s; once more with Reduce Motion on
(`defaults write com.apple.Accessibility ReduceMotionEnabled`); then the whole UI suite.

**Result, 2026-11-10.** The first frame the app draws is the launch screen's, the logo
where the system centred it, on black. The smoke grows on the pad, each cloud under its
column, the shuttle is past the top edge at 1.2 s, and the globe comes up under the
smoke from 1 s, clear at 1.5 s. With Reduce Motion the launch screen gives way to the
globe and nothing moves. The UI suite passed (35 tests, 4 skipped), the animation
skipped on its test catalog. Not checked: an iPad or any device's screen, where the
build was only installed and launched; an upgrade over a version whose cached launch
screen is still the logo's #0b222d; and a touch on the globe in the first second, which
reaches it under the black.

## Native app on the Mac: mouse, trackpad, keys and menus

**Procedure.** `make run-mac`. On the globe: drag to turn it; scroll with a mouse
wheel and with two fingers on a trackpad to zoom; pinch and twist on the trackpad;
click a satellite, then double-click the globe, then triple-click it; right-click,
Control-click and force-click the globe for the globe menu, and check that a force
click selects nothing. Without clicking first, press the arrows, + and -, the space
bar (the clock stops and starts), and Escape with a panel open, with a satellite
selected, and after Hide UI (⇧⌘H). Type a space in the satellite search and check
that the clock runs on; pick a satellite there, and check that the arrows turn the
globe again without a click. Select a satellite and a station, and check that each
card holds its title and buttons, grey and without a bezel as a panel's close
button. Check that the globe reaches the window's top edge under its buttons, that
the column and the corner buttons stay below them, and that dragging that strip
moves the window and double-clicking it fills the screen. Try each command of the
View, Satellite and Bookmarks menus, Help's links, Edit > Copy Link to This View
(⇧⌘C) and the link it copies. Open Bookmarks from its entry and from ⌘B, as a
panel beside the column, share the view from it, and open a bookmark and the
default view from it: each closes the panel, not the window. Open About from the
menu column and the app menu. Move the window to a display with another refresh rate
and check `device_max_fps` in a benchmark report. Cover the window with another
and check in Activity Monitor that Satvis's GPU use falls to nothing. Narrow the
window to its smallest, track a satellite, quit, and check that it opens again
where and as large as it was, tracking it. Close the window and check that the app
quits. With a pass alert saved, launch and check
`log stream --predicate 'subsystem == "org.frcy.app.satvis"'` for no errors.

**Result.** Not yet run: an agent's shell has no accessibility access to drive the
Mac app, and Automation Mode, which Mac UI tests need, asks for the user's
password.
