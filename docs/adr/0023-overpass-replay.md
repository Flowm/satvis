---
status: accepted
---

# Overpass replay: a polar orbiter's granules behind the clock

The globe draws instrument imagery at the clock's time, one frame at a time (ADR 0020).
For a polar orbiter's daily layer that frame is a whole day's swaths, joined: nothing
says when the satellite saw a place, and the satellite drawn at the clock's time flies
over pixels another orbit took. Replaying an overpass, the satellite crossing a place
and its swath appearing behind it, needs each granule's time and its ground
(`docs/proposals/imagery-availability.md`, "Overpass replay: what it needs").

Measured on 2026-11-20 and 21, from this app's origin:

- **GIBS has NOAA-20's VIIRS a granule a frame**:
  `VIIRS_NOAA20_CorrectedReflectance_TrueColor_Granule`, PNG, a frame every 6 minutes
  for 90 days, transparent outside the granule. Its time domain lists every 6 minutes,
  and of the 158 day granules over Munich in those 90 days it had 96: a granule it left
  out answers 404 at every tile.
- **GIBS cannot say which granules cover a place.** Its DescribeDomains answers the
  whole globe whatever bounding box it is given, in either projection.
- **NASA's CMR can**: a granule's start, end, day or night flag and a four-corner
  polygon, queried by time and by point, with CORS and no key. It asks for a
  `Client-Id`, which its CORS allows. The standard collection (`VJ103MOD`) ran 4 days
  behind; the near-real-time one (`VJ103MOD_NRT`) holds the last week, about 3 hours
  behind.
- **NOAA-21's granules are in CMR and not in GIBS.** `VJ203MOD_NRT` listed 240 granules
  of 2026-11-20 and `VJ203MOD` goes back to 2023-02-10, but GIBS lists no NOAA-21
  granule layer in either projection and answers 400 for the name NOAA-20's has.

## Decision

**A granule layer is an entry of the imagery manifest (ADR 0019) that names its CMR
collections**: `granules: [VJ103MOD_NRT, VJ103MOD]`, the near-real-time one first,
beside NOAA-20's daily VIIRS layer. Only a GIBS layer the globe draws with a period of
minutes may have it. The record carries the collections' names, not a query, as it
carries a layer's id and not a url.

**A satellite whose granules no provider pictures has its outlines alone**: a `cmr`
entry of kind `outline`, its `layer` the standard collection, its `granules` as above,
and no tiles: NOAA-21's, beside its daily VIIRS layer. It is a granule layer whose
granules all keep their outline in the replay's colour, as nothing is missing from it;
its card says "Outlines only" where a picture would be, and a station's rows say "Outline
only". When GIBS has NOAA-21 granules, the entry becomes a GIBS one like NOAA-20's.

**The globe shows the granules behind the clock** (`GranuleImagery.ts`): every day
granule that started in the last 50 minutes, about the daylit half of an orbit, each as
its outline and, over it, its GIBS frame as a layer of its own, the older below. A granule
appears whole when the clock passes its start and goes 50 minutes later, so the swath
builds up behind the satellite and falls away. A night granule has no true colour pixels
and is not drawn.

- The granules come from CMR, four hours around the clock's hour, again when the clock
  leaves them, and every 10 minutes while they reach the last four hours, as CMR lists a
  granule hours after it is sensed. A granule both collections list is drawn once.
- Before its layer is made a granule's level-0 tile is fetched. A 404, or a tile with
  fewer than 50 opaque pixels, means GIBS has no picture of it: its outline turns grey
  and no layer asks for tiles that cannot come. A day granule covered 294 to 770 of
  that tile's pixels; the one that crossed the antimeridian at 23:30Z on 2026-11-20, 1,
  and GIBS's WMS drew nothing of it.
- A tile GIBS fails is asked for twice more. Of 461 granule tile requests in one replay,
  7 came back 500, and each came on a second request.

**A replay is the layer, the clock and the camera, and nothing else**: the satellite on,
its granule layer on, the clock set back and playing, and the camera looking straight
down from 5,000 km, untracked (`CesiumController.replay`). The url already holds the
first three (`sats`, `imagery`, `time`), so a replay is a link and needs no parameter.

**Two places start one**:

- **The granule layer's Imagery tab card** pictures the newest day granule GIBS has
  pixels of, from the last 12 hours, and its "Replay" button plays from 20 minutes before
  it at 60×, the camera above that granule, so the satellite comes up to it.
- **A ground station's Imagery tab** lists the station's overpasses by day in the last
  30 days, newest first, from a CMR query on its point: whether GIBS has the image of
  each, part of it, or the outline only. A row plays from 5 minutes before the overpass
  at 30×, the camera above the station. It lists every loaded satellite with a granule
  layer, on or not, and offers to load every group where none is.

## Consequences

- **NOAA-20 alone has a granule layer with pixels**, NOAA-21 one of outlines. GIBS has
  the same layer of Suomi NPP, which stopped in November 2026, and of no other
  satellite. The rest of the proposal's table needs another picture source: MODIS has
  none per granule, Sentinel-2's are per tile.
- **Two in five daytime overpasses are outlines only**, as GIBS left those granules out.
  Which it leaves out is not published.
- **The browser's console shows a 404 for each granule GIBS lacks**: the level-0 probe.
  Caught, never thrown.
- **The satellite is drawn from today's element set** at the replayed time. Over the 90
  days GIBS keeps that is a few km along the track for NOAA-20 (the proposal), well
  inside a 3,000 km swath: on 2026-11-20 the satellite drawn at 23:27 lay inside the
  23:24 granule.
- **A replay costs a CMR query an hour of clock time**, a probe per granule, and the
  tiles of up to nine granule layers at once.
- **The native app draws no granule layer.** It reads the entry as GIBS imagery with a
  6-minute period, one granule a frame, until it learns `granules`. It leaves out a `cmr`
  entry, which has neither a viewer link nor tiles.
- **The Map panel lists the layer under the LEO satellites**, as any other: shown from
  there it follows the clock as here, without the replay's clock and camera.

## Alternatives rejected

- **A daily composite revealed along the drawn swath.** No catalogue, but above 30 to
  40° adjacent orbits overlap and the later one has overwritten the pixel: the replay
  would show another orbit's picture under the satellite.
- **GIBS's time domain as the list of granules**, without CMR. It lists every 6 minutes,
  so a granule it left out shows nothing, there is no outline, and a station's overpasses
  cannot be found.
- **The pass predictor's swath passes as a station's overpasses.** They are predicted
  from the nominal swath and today's element set; CMR's are what was acquired, and say
  which granule to draw.
- **One frame at a time, as `FramedImagery.ts` shows a layer**: a strip 6 minutes long
  that jumps ahead, with the swath before it gone.
- **Clipping each granule to its outline.** GIBS's granule tiles are transparent outside
  it already; Cesium clips the whole globe, not one layer.
- **A `replay` url parameter** for the overpass. The clock, the layer and the satellite
  say it; a second name for it could disagree with them.
- **Tracking the satellite during a replay.** The camera follows the satellite's point,
  so the swath slides under it; looking down on the granule or the station lets it pass.

## Open questions

- **Which other layers are granules?** Sentinel-2's scenes (Earth Search) and Landsat's
  (Planetary Computer) have outlines and pictures, under licences not yet read.
- **Whether CMR minds a replay's load**: no rate is published beyond the 429 it answers
  with. The `Client-Id` names the app.
- **The native app**, which would read the same entry and CMR, and draw a granule's
  frame into its baked surface as it draws any layer.
