---
status: accepted
---

# Surface models are one selection with two shapes

The sky view stands on the ground and looks up. What it lacks is the ground: the
buildings around you tell you where you stand, and what a low satellite is behind.
So the Map menu has a third group beside Layers and Terrain: `None`, `OsmBuildings`,
`GooglePhotorealistic`, at most one, none by default.

The name is **surface model**, not "buildings", because only one of the two is
buildings. Cesium OSM Buildings is extruded footprints only. Google Photorealistic 3D
Tiles is a photogrammetry mesh of ground, vegetation and buildings together: it does
not sit on the globe, it _replaces_ the visible part of it.

That asymmetry is most of this design.

## Decision

### Picking Google hides the globe, and suppresses rather than overwrites

Cesium's guidance is `globe.show = false` with the photorealistic mesh. With the globe
up, the ellipsoid and its imagery z-fight the mesh and terrain spikes through roofs.
Hiding it makes two other Map-menu groups describe nothing.

Those selections are **suppressed, not rewritten**, the same trade
`suppressCameraMode` makes for `?camera=Inertial` and `suppressComponent` makes for
the orbit components across a morph. The store and the URL keep the user's choice,
deselecting gives back exactly what was there, and no history entry is pushed for a
change nobody asked for. The menu dims the inert groups, so it never claims to
describe a picture it is not describing.

### An inert control shows what is in force, and an imposed one declines the click

For terrain, dimming was not enough, and the difference looks like an
inconsistency.

A hidden globe leaves the imagery and terrain choices **still the user's**; they are
just not drawn. So those controls stay live and only dim. An **imposed** terrain is
different: the radio kept reporting the stored choice, so selecting OSM Buildings left
the dot on `None` while World Terrain was drawn. That is a control stating something
untrue. So while a terrain is imposed, the dot follows the terrain **in force** and
the rows are disabled; a control that accepts a click and changes nothing visible is
worse than one that declines it. The note beneath names the imposition and the
terrain that returns, because the radio no longer shows the stored choice.

The terrain provider stays assigned while the globe is hidden. A hidden globe
short-circuits `Globe.update`, `beginFrame`, `render` and `endFrame`, so no terrain
tile is selected, requested or drawn. There is nothing to switch off, and dropping
the provider would only cost a re-fetch on the way back.

### OSM Buildings forces Cesium World Terrain

Its heights assume that terrain, and Cesium has no ground clamping for tilesets. On
any other terrain the buildings float or sink by the difference: metres in flat
country, more in the mountains, and worst directly under a sky-view observer. So
selecting it imposes `CesiumWorldTerrain` while it is up, through the same
suppression path. World Terrain is also an ordinary terrain option, which makes the
imposition legible.

The imposition was questioned and measured. Sampling both terrains at ten cities,
Re:Earth's ground sits consistently _lower_ than World Terrain's: Denver −0.1 m, San
Francisco +0.1 m, Zurich −2.5 m, Innsbruck −2.8 m, Tokyo −4.3 m, Cape Town −5.4 m,
Munich −9.0 m, Grindelwald −9.5 m, La Paz −10.1 m, Berlin −12.9 m. The buildings' feet
are baked at World Terrain height, so on Re:Earth they hover by that amount: about
four storeys in Berlin, at eye level, in the one view this feature is for. Shifting
the tileset by the difference sampled at the observer was considered and declined: it
would fetch World Terrain for someone who chose Re:Earth to stay off ion, and it would
hold only near the observer.

### Where each model applies is data, and one of the two rules is about money

Neither model applies in 2D or Columbus. Cesium does not refuse a tileset there
(`Cesium3DTile` has a 2D screen-space-error branch), so this is a choice: full tile
bandwidth for geometry that looks broken is worse than nothing.

`GooglePhotorealistic` is **sky view only**, for cost, not for a technical reason. It
bills through Google's Map Tiles API per request against our ion account, and
satvis.space is public with the token committed. From a fixed viewpoint looking up,
tile loading is bounded by where the observer stands; on the globe it is bounded only
by how far someone flies. OSM Buildings is a standard ion asset with small tiles, so it
applies in 3D too.

Both rules are `viewModes` on the registry entry, so widening either is one line. They
can be relaxed once real usage is known.

### The sky view needed a new source for the ground under it

`SkyView` read `globe.getHeight` every frame, which is free and correct while the
globe is drawn. With the globe hidden it returns `undefined`, and the fallback left
the eye at ellipsoid height: about 560 m _inside_ the mesh in Munich, looking at the
underside of the ground, a view that never recovers.

So `SkyView` takes a `GroundHeightSource`, asked once per observer, not per frame,
and the surface model answers it with `clampToHeightMostDetailed`. Two consequences:

- It clamps to the **top** of whatever is there, so standing where a building stands
  puts the eye on its roof. That is the only outcome that never buries the view, which
  is why it was preferred to sampling the ground beneath.
- The plausibility guard written for `getHeight` matters twice now: the clamp answers
  against any scene geometry above the point, and a satellite's 3D model passing
  overhead is scene geometry.

The source is permanent and covers every case (surface model, terrain, bare
ellipsoid), and it is asked again whenever what the observer stands on changes. The
per-frame `globe.getHeight` is a fallback of last resort, because _following_ it made
enabling OSM Buildings in the sky view lurch: it answers from whichever tile is
loaded, so the eye rose in steps as terrain refined.

The flip had a different cause. Imposing World Terrain replaces the ground under the
observer, and a height that arrives a beat after the terrain leaves the eye _under_
the new surface for that beat (570 m under it in Munich). From inside the terrain you
see its underside, which reads as the world turning inside out. So the terrain swap
measures the new provider at the observer _before_ handing it to the viewer, and sets
the height at the same time. Traced: two eye heights, 2 m then 572.8 m, one
transition, in the frame the provider changes.

### On the ground, buildings are only worth loading as far as you can see

Cesium rolls a tileset's screen-space error off with camera distance
(`dynamicScreenSpaceError`, on by default), but its defaults are sized for looking
_down_ at a city. From two metres above the pavement they refine buildings out to
about 5.2 km, which buys tiles behind buildings you cannot see past.

In the sky view only, OSM Buildings gets a sharper roll-off: density 8.0e-4 and factor
48 instead of 2.0e-4 and 24. The numbers are derived: the reduction at distance `d` is
`factor * (1 - exp(-(d * density)^2))`, and refinement stops once that reaches the
16-pixel maximum error, which puts the edge at about 800 m.

Measured on one camera at Marienplatz, settled: 34.38 MB across 34 tiles capped,
against 39.73 MB across 40 tiles at the defaults. **A 13% saving, not a
transformation.** The remaining 34 MB is the neighbourhood you stand in, and it cannot
be cut without deleting buildings you can see.

The cost was accepted knowingly: OSM Buildings refines _additively_, so beyond the
edge distant buildings are absent, not coarse. At street level the near buildings hide
that distance anyway. From a rooftop it would show.

The photorealistic mesh does not get this roll-off. It _is_ the ground, and capping
its radius would delete the horizon, not just buildings behind other buildings.

On the globe the roll-off stays at Cesium's defaults, and a **hard ceiling** withholds
the tileset instead: above the ceiling the OSM Buildings tileset is hidden. This is a
different mechanism on purpose. `show = false` is the one setting Cesium treats as
nothing to do: it skips all of `Cesium3DTileset.updateForPass`, and
`preloadWhenHidden` is off by default, so a hidden tileset makes _no_ requests, where
tuning the error can only make fewer.

The ceiling was first 2 km, roughly where a five-storey block stops being legible
looking down (about ten pixels tall). Measured then at three altitudes over one city:
9,261 km hidden, 0 tiles, 0 MB; 2,500 m hidden, 0 and 0; 1,400 m shown, 35 tiles,
44 MB. Below the ceiling buildings fill in at the usual radius, which keeps an
ordinary 3D city view worth having. In the sky view the ceiling is lifted entirely,
not just satisfied by standing on the ground.

The ceiling is now **1 km above the _ground_** (`GLOBE_BUILDING_CEILING` in
`src/modules/SurfaceModel.ts`). Measured from the ellipsoid, a 1 km ceiling would put
La Paz 2.6 km over it with its buildings permanently absent. The last believable
ground height is kept, as the sky view keeps its own, because while terrain arrives
`getHeight` answers nothing or nonsense (a coarse tile has returned −76594), and
reading that as sea level would make the gate strictest while it knows least.

### What else the bandwidth went on

Four more savings, most valuable first.

**The mesh waits for the descent to land.** Entering the sky view is a flight down to
the pavement, and the mesh used to be added the moment the view mode changed, so it
streamed photogrammetry for altitudes the camera passes in two seconds. It is now
withheld until `SkyView.settled`, with the globe standing in until then. That is why
`#syncGlobe` asks whether the tileset is _shown_, not whether it exists. Measured: 0 MB
of mesh during the descent, requests starting on landing.

**The mesh skips intermediate levels of detail.** With `skipLevelOfDetail` and
`immediatelyLoadDesiredLevelOfDetail`, "only tiles that meet the maximum screen space
error will ever be downloaded", so the chain of coarser tiles is never fetched. On a
tileset about twenty levels deep that should be most of the bytes. This is reasoned,
not measured: a clean before-and-after needs an uncached city and Google quota. The
cost is that a view resolves out of nothing, not out of a blurry stand-in.

**The mesh's error tolerance is 24 everywhere**, up from Cesium's 16, on phones and
desktops alike. This is the one saving that costs picture quality, not only patience.
It is acceptable because the mesh degrades (blurrier, never absent), where the same
change to OSM Buildings would delete buildings.

**The service worker caches neither ion assets nor Google's tiles.** Cesium allows
caching only as "a general caching mechanism for performance that caches other
internet traffic as well, and not just Cesium Data Output", and Google's Map Tiles
policies restrict caching `tile.googleapis.com`. So a second sky-view session over the
same city pays for its tiles again, beyond ion's own `public, max-age=86400` in the
browser cache. A runtime caching rule must not cross this boundary.

### The matrix is Cesium-free and tested

The rules above are one pure function, `surfaceEffects(surfaceModel, viewMode)`, in
`src/config/surfaceModels.ts`. The menu's dimming and the scene's contents come from
the same call, so a rule cannot hold in the renderer and not in the UI.
`src/modules/SurfaceModel.ts` is a thin executor: create, add, hide, measure, destroy.

The menu's sentences are derived too, by `viewModeNote`. The note was first written by
hand in the template, which made "widening `viewModes` is one line" false: the second
line was a sentence elsewhere that would then state a restriction no longer in force.

### An ion token is committed

`src/config/ion.ts` carries a token restricted at ion to satvis.space, so production
works from a clean checkout and the token is useless to anyone who copies it out of
the repository. The MapTiler key makes the same trade. `.env.production` could not do
this: it is gitignored, so a CI build would ship no token.

That restriction is why `VITE_CESIUM_ION_TOKEN` exists: ion rejects the committed
token on localhost, on `deploy:preview` origins, and in iframes on foreign domains. It
is set globally as `Ion.defaultAccessToken`, because
`createGooglePhotorealistic3DTileset` resolves its ion asset through
`IonResource.fromAssetId` internally, with no way to pass a token.

### A failure reverts the selection

There is no equivalent asset to swap in, so a tileset that fails to create puts the
selection back to `None` and says why in a toast. The commonest cause is a token this
origin may not use, and nothing else in the UI would explain that.

Per-tile failures only warn, once per tileset. One 403 tile is no reason to tear down
the surface, and the causes that fail one tile fail hundreds; a flooded console says
no more than one line.

## Consequences

- **The photorealistic mesh's cache is reduced** from Cesium's defaults for this
  tileset (1.5 GB plus a 1 GB overflow, sized for a desktop flying the globe, not a
  phone standing still), and more so on constrained devices. "Constrained" is iOS **or
  a device that cannot hover** (`hover: none`), which catches Android where an iOS
  check alone gave it the desktop budget. It is not an iframe test, because an embed
  on a desktop has a desktop's memory. The mesh also runs with
  `dynamicScreenSpaceError`, which Cesium recommends for photogrammetry, and
  `showCreditsOnScreen: true`, following Google's Map Tiles policies, not Cesium's
  reading of them. `enableCollision` stays at Cesium's default `true`: with the globe
  hidden, the mesh is the only thing that stops the camera dropping through the
  ground.
- **Ground-clamped overlays still work under the mesh.** Verified: the ground-track
  corridor's `classificationType` defaults to `BOTH`, and with no globe depth it drapes
  onto the tileset, following the street and occluded by the buildings. Where the mesh
  has no coverage there is nothing to drape on, and no globe either.
- **Ground-station pins are clamped.** Stations are placed at height 0, so the pin sat
  below any real surface. That was already wrong under terrain; the mesh made it
  obvious.
- **Every visitor can spend our ion quota**, bounded by the sky-view restriction and
  observed through the PostHog event `surface_model_selected`, which carries the view
  mode. It fires on **selection**, not on load: a failed choice, or one armed in a
  view mode that cannot honour it, is worth seeing, and a load-time event missed those
  and fired again on every sky-view entry. If the quota proves too generous, the
  restriction tightens in `surfaceModels.ts`; if it proves cheap, 3D opens the same
  way.
- **`?surface=` is carried where it cannot apply**, so a model can be armed before
  entering the sky view, and `?surface=GooglePhotorealistic&scene=Sky` works. The menu
  annotates the selected-but-inactive case and does not disable the control.
