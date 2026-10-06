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
