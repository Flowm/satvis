# Native app: manual verification

What the native app's tests cannot check (`ios/`), rerun when the code it covers
changes, with what each run returned. The web app's checks are its e2e suite.

## Native app: Re:Earth terrain, and what it asks of Re:Earth

**Procedure.** In the iPhone 17e simulator (3× screen), with the Map menu's
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
