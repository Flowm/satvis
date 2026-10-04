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
