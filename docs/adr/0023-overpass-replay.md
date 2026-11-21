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
- **Today's element set places the satellite on its granules, less so the older they
  are.** At a granule's start the satellite drawn lay off its start edge along the track by
  about 10 km a day back, 30 km a week back, 50 km 15 days back and 125 km 30 days back
  for NOAA-20, and within 12 km over 30 days for NOAA-21; across the track within 17 km.
  A granule's scan line reached 1,505 to 1,562 km either side, the ribbon's 1,565.
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

**Where the satellite is drawn, a granule fills in behind its scan line** (`GranuleLayers.ts`):
the plane of the ground track fan, a component of its own that reaches from the satellite across
the track to its swath extents, the ground track ribbon's at the satellite. While the
satellite drawn is over a granule, the granule is a ground primitive in its outline whose
shader discards what lies ahead of that plane and shows, behind it, GIBS's WMS picture of
the granule (2,048 pixels across as JPEG, 577 KB for one over Europe; PNG was 5 MB), or
for a `cmr` layer a faint fill, which it keeps. Once the satellite has passed every corner,
the granule gets its outline and tile layer, and the picture's fill goes when the layer's
tiles have come. The fill, the fan and the ribbon so meet at the satellite drawn, wherever
an old element set puts it: an old NOAA-20 granule fills up to 17 s early or late, not
with its edge apart from the fan. A granule more than two minutes past its end counts as
passed, as the plane, through the Earth, turns back toward it half an orbit later; one
across the antimeridian or near a pole fills without a picture, and one GIBS has no
pixels of fills grey, as its outline will be.

**The fill is shaded as the globe shades its tiles.** A ground primitive gets none of the
globe's shading, so unshaded a granule filling in over Siberia at noon in November read
30% brighter than its tiles once passed (mean 179 against 138). Its shader does what
Cesium's `GlobeFS.glsl` does to imagery, from the globe's settings as uniforms: linear
colour under HDR, the sun's diffuse light, and the ground atmosphere per fragment. The
same spot then reads 137.8 against 137.9. It copies @cesium/engine 26.5's shader, and is
to be checked against it when Cesium is upgraded.

**A replay is the layer, the clock and the camera, and nothing else**: the satellite on,
its granule layer on, the clock set back and playing, and the camera looking straight
down from 5,000 km, untracked (`CesiumController.replay`). The url already holds the
first three (`sats`, `imagery`, `time`), so a replay is a link and needs no parameter.
While its layer is on, the satellite has its ground track fan, whether or not the
component is.

**Two ways to watch the granules**, as there are two questions: what a station saw, and
what a satellite records as it flies.

- **The swath as sensed is a layer, not a mode.** The satellite's Imagery tab card ("Swath
  as sensed") and the Map panel's LEO group show it like any layer: it follows the clock,
  wherever the clock is. The card can track the satellite, as the info panel's camera
  button does. CMR lists a granule about three hours after it is sensed, so nearer live
  it has nothing: the timeline shades where the layer has granules by day, a day either
  side of the clock (`useSensedSpans.ts`), and where the clock is past the newest, the card
  says how far behind live that is and goes to it, keeping the speed and the tracking.
- **A station's overpass is a replay** (`useOverpassReplay.ts`), started from a pass in the
  Passes table. While one is on, a bar over the clock (`ReplayBar.vue`) names it and steps
  to the station's overpass before or after, at the speed the clock runs. Exit takes the
  layer off and goes back to live; the camera stays. Taking the layer off elsewhere ends
  the replay too.

- **The Passes table** (`passImagery.ts`), a station's or a satellite's: a past pass of a
  satellite with a granule layer is the overpass CMR lists over the station in the last
  30 days that overlaps it, within the fill's 2 minutes. Its Image column says whether
  GIBS has the image of it, part of it, the outline only, or it was night, and replays it
  from 5 minutes before at 30×, the camera above the station. With Past on, the recorded
  overpasses by day the predictor no longer has, as it looks back a day and CMR a month,
  are rows of their own, so what is to come is predicted and what is past is recorded.
  The Imaged switch keeps the recorded passes alone. It asks CMR for the satellites drawn,
  as the passes are theirs, and at most 6 satellite and station pairs.

## Consequences

- **NOAA-20 alone has a granule layer with pixels**, NOAA-21 one of outlines. GIBS has
  the same layer of Suomi NPP, which stopped in November 2026, and of no other
  satellite. The rest of the proposal's table needs another picture source: MODIS has
  none per granule, Sentinel-2's are per tile.
- **Two in five daytime overpasses are outlines only**, as GIBS left those granules out.
  Which it leaves out is not published.
- **The browser's console shows a 404 for each granule GIBS lacks**: the level-0 probe.
  Caught, never thrown.
- **The satellite is drawn from today's element set** at the replayed time, up to 125 km
  along the track from where NOAA-20 was 30 days back, not the few km the proposal
  expected. The granules fill in behind it, so they keep to it.
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
- **Filling a granule by its own times**, from its start edge to its end edge. True to
  CMR, but on an old NOAA-20 overpass the fill's edge ran up to 125 km from the fan.
- **The sensor cone as the fan.** It stays round, as other satellites' instruments are;
  the fan is a component beside it.
- **The fan only with a replay, not a component.** It is the ground track's edge at the
  satellite, of use without a granule layer too; a replay draws it for its satellite alone.
- **A station Imagery tab beside its Passes**, listing CMR's overpasses alone. For a
  satellite with a granule layer they are the same events as its swath passes, in two
  lists with two clicks: one jumped the clock, the other replayed.
- **Following the satellite as a mode**, a button that tracks it from its latest recorded
  orbit with a bar to step orbits, or a list of recorded orbits to pick from (prototyped on
  the branch `prototype/follow-sensing`). Both named a time to start from, which the clock
  already holds; the layer with the timeline's shading asks nothing new of the user.
- **Clipping the granule's tile layer as it fills.** Cesium clips the whole globe, not a
  layer, and a tile it has drawn is not drawn again.
- **Tracking the satellite during a replay.** The camera follows the satellite's point,
  so the swath slides under it; looking down on the granule or the station lets it pass.

## Open questions

- **Which other layers are granules?** Sentinel-2's scenes (Earth Search) and Landsat's
  (Planetary Computer) have outlines and pictures, under licences not yet read.
- **Whether CMR minds a replay's load**: no rate is published beyond the 429 it answers
  with. The `Client-Id` names the app.
- **The native app**, which would read the same entry and CMR, and draw a granule's
  frame into its baked surface as it draws any layer.
