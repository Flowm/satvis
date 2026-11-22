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
collections by concept id**: `granules: [C2208781576-LANCEMODIS, C2105084593-LAADS]`
(`VJ103MOD_NRT` and `VJ103MOD`), the near-real-time one first, beside NOAA-20's daily
VIIRS layer, or one collection of EUMETSAT's Data Store, and with `platform` the
satellite where a collection lists several (HLS, Sentinel-3). Only a GIBS or EUMETView
layer the globe draws, or a `cmr` one, may have it, its `period` then the granules'.
The record carries the collections' ids, not a query, as it carries a layer's id and
not a url. A short name is not enough: MODIS's near-real-time and standard collections
are both `MOD03`, told apart by version alone, and their granule ids start alike. With
the concept id, CMR says which collection each granule is of, so the code knows nothing
of any instrument: a satellite is added in the manifest alone.

**A EUMETView layer of a swath an orbit is cut to its granules**: Sentinel-3A's and 3B's
OLCI, with the granules of `OL_1_EFR___` as EUMETSAT's Data Store lists them
(`EO:EUM:DAT:0409`, `platform: Sentinel-3A`): 2 hours behind live, where CMR's
`OLCIS3A_L1_EFR` was 26, from 2024-07-26 on. The Data Store answers any origin without a
key, lists a granule twice for three weeks (near-real-time and archived, starts within
microseconds, kept once), and splits one across the antimeridian in two, joined again.
A frame is a whole day pass, so a tile layer of it would show the pass ahead of the
satellite; each granule is instead its fill (below), the frame's WMS picture cut to its
outline, kept once passed. EUMETView stamps a pass about when it ended, from 9 minutes
after the equator in June to 22 in November as the pass reaches further south, and
answers a time with the pass stamped nearest it: the entry's `frame: PT25M` asks for a
granule's start plus 25 minutes, within 50 of its pass's stamp, as a day pass lasts up to
an hour and the passes come 101 minutes apart.
The times its capabilities list are no guide: 101 minutes apart from February 2020, they
drift from the passes by 33 minutes a year (measured 2021 to 2026-11-22, both satellites),
and the frame stamped nearest the clock, as a frame layer shows, is often the orbit before.
Before its picture is asked for, a 16-pixel picture of 2° around the granule's centre
says whether the pass has it: Sentinel-3A's lacked most of 2 of 10 passes on 2026-11-20;
a granule it lacks turns grey, outline and fill, as a GIBS one does. As JPEG on black, the
picture is 1,024 pixels across, as it is kept for the granule's 50 minutes: a trail of 17
is 56 MB of textures, 220 MB at GIBS's 2,048. EUMETView's JPEG is white where it has no
pixels. EUMETView draws a box across the antimeridian, given as running past 180° east;
GIBS's WMS draws nothing for one, so a GIBS picture there is joined from its two sides, and
a probe is kept to one side. Without its picture, such a granule's tint showed the triangle
where Cesium cuts its polygon at 180°, and the overlap of neighbouring granules (Terra,
2026-11-09 20:10Z); a picture is opaque, and hides both.

**A `cmr` layer's granules are cut from another layer's frames**, named in its `pictures`:

- **A daily layer** (`frame: day`): Terra's and Aqua's MODIS, NOAA-21's VIIRS and PACE's
  OCI from their GIBS daily pictures, and Landsat 8 and 9 and Sentinel-2A and 2B from
  GIBS's daily HLS pictures of each pair, with the 110 km scenes of `HLSL30` and `HLSS30`
  by `platform`, about three days behind live. A granule's frame is its UTC day's. Within
  60° of the equator the day's picture holds that granule's pixels, as the day's passes do
  not overlap there but at the swath's edge; past it a granule fills without a picture.
- **EUMETView's six orbits stacked** (`frame: PT35M`): Metop-B's and Metop-C's AVHRR, with
  the 10-minute granules of NOAA's sea surface temperature from it (`AVHRRF_MB-STAR-L2P`),
  an hour behind live. Those say neither day nor night, so the sun at their corners does.
  EUMETView stamps a frame when its newest orbit's data ends, 20 to 55 minutes after a
  day granule starts (Metop-B and C, 2026-10-02 and 11-18/21): start plus 35 minutes is
  the frame where the granule's orbit is the newest, over the orbits before it. The
  Data Store lists Metop's AVHRR only by whole orbit.

A kept picture is at most 256 pixels a degree and 1,024 across: an HLS scene is 1.4°, and a
trail of 60 is 32 MB of textures. Without `pictures`, a `cmr` entry of kind `outline` has
the outlines alone: its granules all keep their outline in the replay's colour, its card
says "Outlines only" where a picture would be, and a station's rows say "Outline only".
No satellite has one now. When GIBS has NOAA-21 granules, its entry becomes a GIBS one
like NOAA-20's.

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
- A granule found without pixels is asked again after 10 minutes, as a provider may still
  be taking it in: a daily picture fills over its day, and EUMETView's swaths come hours
  after the Data Store lists their granules. One found with them stays.
- A tile GIBS fails is asked for twice more. Of 461 granule tile requests in one replay,
  7 came back 500, and each came on a second request.

**Where the satellite is drawn, a granule fills in behind its scan line** (`GranuleLayers.ts`):
the plane of the ground track fan, a component of its own that reaches from the satellite across
the track to its swath extents, the ground track ribbon's at the satellite. While the
satellite drawn is over a granule, the granule is a ground primitive in its outline whose
shader discards what lies ahead of that plane and shows, behind it, GIBS's WMS picture of
the granule (2,048 pixels across as JPEG, 577 KB for one over Europe; PNG was 5 MB), or
for a `cmr` layer a faint fill. Once the satellite has passed every corner, the granule
gets its outline and, for GIBS, its tile layer, and the picture's fill goes when the
layer's tiles have come; a `cmr` or EUMETView granule keeps its fill. A fill is a ground
primitive, drawn over every imagery layer, where a GIBS granule's tile layer takes its
place among them: another instrument's layer turned on later lies over GIBS's granules,
and under EUMETView's. The fill, the fan and the ribbon so meet at the satellite drawn, wherever
an old element set puts it: an old NOAA-20 granule fills up to 17 s early or late, not
with its edge apart from the fan. A granule more than two minutes past its end counts as
passed, as the plane, through the Earth, turns back toward it half an orbit later; one
more than 90° of longitude across, near a pole, fills without a picture; one its provider has no pixels of fills grey, as its outline
will be.

**The fill is shaded as the globe shades its tiles.** A ground primitive gets none of the
globe's shading, so unshaded a granule filling in over Siberia at noon in November read
30% brighter than its tiles once passed (mean 179 against 138). Its shader does what
Cesium's `GlobeFS.glsl` does to imagery, from the globe's settings as uniforms: linear
colour under HDR, the sun's diffuse light, and the ground atmosphere per fragment. The
same spot then reads 137.8 against 137.9. It copies @cesium/engine 26.5's shader, and is
to be checked against it when Cesium is upgraded.

**A replay is the layer, the clock and the camera, and nothing else**: the satellite on,
its granule layer on, the clock set back and playing, and the camera on the pass
(`CesiumController.replay`). The url holds the first three (`sats`, `imagery`, `time`)
and `replay` the station, which nothing else says, so a replay is a link that opens with
its bar. The camera is not in it: how to watch is the viewer's, as the free camera is.

**The replay bar picks the camera** (`ReplayCamera.ts`), and it stays picked for the next
replay. Chosen from five prototyped (branch `prototype/satellite-tracking-angles`):

- **Nadir**, the first: straight down on the station from 5,000 km, north up, untracked;
  what a replay did before, and a view the user is free to move.
- **Tracking**: tracking the satellite, which chases its swath while the layer is on (below).
- **Broadcast**: held 1,800 km above a point beyond the station, on its side of the ground
  track, and turning to keep the satellite in view, as a camera beside a race track. The
  station is in the foreground, the satellite crosses it with its fan, and the swath
  builds up across the view. A drag or a zoom takes the camera back, where it stays.

**Tracking a satellite while its recorded swath is on chases the swath**: from behind and
above, 40° down onto the ground under the satellite, so the satellite sits up the screen
and the swath it has recorded fills the rest. The distance grows with the swath's width,
from 1,180 km for Landsat's 185 km to 3,100 km for VIIRS's 3,000. It is tracking as any
other (`viewFrom`), turned down past the satellite once it starts: EntityView aims at the
satellite and keeps the camera's direction after, so the swath behind would be off the
bottom of the screen.
While its layer is on, the satellite has its ground track fan, whether or not the
component is.

**Two ways to watch the granules**, as there are two questions: what a station saw, and
what a satellite records as it flies.

- **The recorded swath is a layer, not a mode.** The satellite's Imagery tab card ("Recorded
  swath", for the data a satellite recorded, which comes hours to a day behind live; "Passes"
  since ADR 0024, whose notice offers to go to the newest pass where the clock is past it) and the Map panel's LEO group show it like any layer: it follows the clock,
  wherever the clock is. The card can track the satellite, as the info panel's camera
  button does. CMR lists a granule hours after it is sensed (about 3 for VIIRS and MODIS,
  a day for OLCI), so nearer live it has nothing: the timeline shades where the layer has granules by day, a day either
  side of the clock (`useSensedSpans.ts`), and where the clock is past the newest, the card
  says how far behind live that is and goes to it, keeping the speed and the tracking.
- **A station's overpass is a replay** (`useOverpassReplay.ts`), started from a pass in the
  Passes table: its start, or its picture icon where it was recorded by day. The newest
  recorded by day is one press away wherever the table's subject is: the replay button in
  the info panel's header, the "Last imaged" box over the table, and a station pin's globe
  menu, which opens the station's passes first (`useLatestReplay.ts`). While one is on, a bar over the clock (`ReplayBar.vue`) names it and steps
  to the overpass before or after among the table's recorded ones by day
  (`replaySteps`), at the speed the clock runs: a station's table steps through every
  satellite over it, a satellite's through its overpasses over every station. A step to
  another satellite takes the replay's layer off and puts the other's on. A replay opened
  from a link steps through its layer's overpasses over its station, as it has no table.
  Exit takes the layer off and goes back to live, and the camera, whichever it was, back to
  the view the replay started from, as the clock: a broadcast left at its place would watch
  where the satellite no longer is. Taking the layer off elsewhere ends the replay too.

- **The Passes table** (`passImagery.ts`), a station's or a satellite's: a past pass of a
  satellite with a granule layer is the overpass CMR lists over the station in the last
  30 days that overlaps it, within the fill's 2 minutes. Its Image column says whether
  GIBS has the image of it, part of it, the outline only, or it was night, and replays it
  from 5 minutes before at 30×, watched from the replay's camera. With Past on, the recorded
  overpasses by day the predictor no longer has, as it looks back a day and CMR a month,
  are rows of their own, so what is to come is predicted and what is past is recorded.
  The Imaged switch keeps the recorded passes alone. It asks CMR for the satellites drawn,
  as the passes are theirs, and at most 6 satellite and station pairs.
- **A granule's picture is credited as its layer is.** A fill is no tile of an imagery
  layer, so while one shows a picture its layer adds the credit to each frame: GIBS's, or
  EUMETView's as EUMETSAT's data policy (amended 2025-11-25) and the Copernicus legal notice
  word it, "Contains modified Copernicus Sentinel data <year> processed by EUMETSAT" or
  "Contains modified EUMETSAT Metop data <year>", the year the clock's. The Data Store's
  search lists Sentinel-3's granules without a login and passes on no data, and Sentinel
  data is free to show and modify by EU law (Regulation 1159/2013); read 2026-11-22.

## Consequences

- **Fourteen satellites have a recorded swath with pictures**: NOAA-20 and Suomi NPP from
  GIBS's granule layers, the only ones it has (read 2026-11-22); Sentinel-3A and 3B and
  Metop-B and C from EUMETView; Terra, Aqua, NOAA-21, PACE, Landsat 8 and 9 and
  Sentinel-2A and 2B cut from GIBS's daily pictures. Suomi NPP's stopped on 2026-11-02,
  and GIBS keeps its granules 90 days. Sentinel-2C has no HLS scenes yet.
- **A granule cut from a daily picture may show another pass at its edges**, where the
  next orbit's swath overlaps it: VIIRS's from about 20° from the equator, MODIS's from 35°.
  Which pass a daily picture keeps there is GIBS's.
- **Metop's recorded swath is natural colour**, EUMETView's day RGB, not true colour.
- **A card pictures the newest granule within 50° of the equator**, as its picture is held
  there, and "Go to latest" goes to it; Sentinel-3's passes end at 84° S in November. Its
  hint that nothing is sensed yet still counts from the newest granule.
- **"Latest" is the pictures', not the catalogue's**: the newest granule is looked for up
  to the newest frame its pictures list, as GIBS's daily DescribeDomains or EUMETView's
  capabilities give it (plus an hour, as that grid drifts from the frames). On 2026-11-22
  PACE's daily OCI ended on 11-09 and EUMETView's Sentinel-3 swaths were five hours behind
  the Data Store's granules, so the newest granules had no picture yet.
- **A cut picture is asked for up to three times**: GIBS's WMS answers about one small
  request in five with an empty exception, status 200 (2026-11-22), and the next with the
  picture. The card previews do the same.
- **A Sentinel-3 granule has a picture of fixed detail**, 1.2 km a pixel, where a GIBS
  granule's tile layer sharpens to 300 m as the camera comes closer.
- **Sentinel-3's fan is SLSTR's swath, not OLCI's**: the swath is one a satellite, in the
  core config, and Sentinel-3's is SLSTR's. OLCI's granules are its own.
- **A granule may end a second before the next starts** (PACE, OLCI), so granules up to a
  minute apart are one overpass.
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
- **A `replay` url parameter naming the overpass.** The clock, the layer and the satellite
  say it; a second name for it could disagree with them. The parameter names the station
  alone.
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
- **Tracking the satellite during a replay as tracking framed it.** EntityView aims at the
  satellite, so the swath slides under it out of view. The chase aims at the ground under
  it instead, and is one of the replay's cameras.
- **Look-back**, ahead of the satellite looking back at it and the swath behind: its fan
  covered the newest strip, and the satellite was lost against the swath.
- **Nadir turned track-up**, the satellite flying up the screen: little over nadir.
- **The camera in the url**: a link would open with whoever shared it's way of watching.

## Open questions

- **Which other layers are granules?** Sentinel-2's scenes (Earth Search) and Landsat's
  (Planetary Computer) have outlines and pictures, under licences not yet read.
- **Whether CMR minds a replay's load**: no rate is published beyond the 429 it answers
  with. The `Client-Id` names the app.
- **The Data Store's fair usage**: it throttles, but its limits are on a portal page that
  would not load (2026-11-22).
- **The native app**, which would read the same entry and CMR, and draw a granule's
  frame into its baked surface as it draws any layer.
