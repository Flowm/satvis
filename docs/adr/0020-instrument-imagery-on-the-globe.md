---
status: accepted
---

# Instrument imagery on the globe

A record says which provider's layer shows an instrument (ADR 0019), and the
info panel links it. The same entry is enough to draw the layer on the globe at
the clock's time, as the Map panel's `VIIRS` basemap already was. What was missing:
which tiles a layer has, how a drawn layer is named in the url, and where it sits
among the Map panel's layers.

## Decision

**An entry the globe can draw carries its tile set**: `maxLevel`, the deepest level
worth asking for in 256-pixel Web Mercator tiles, and `format`, the tiles' type. For
GIBS they are the N of the layer's `GoogleMapsCompatible_LevelN` set and `png` or
`jpeg`, read from its capabilities; the layer id says neither. EUMETView's WMS draws
any tile, so there `maxLevel` is the first level finer than the picture's own pixels
under the satellite, measured from a tile. An entry without them is a link only.

**GIBS and EUMETView, on the web.** `drawnImagery` in `src/config/instrumentImagery.ts`
reads what the globe needs of an entry, and gives nothing for another provider. A GIBS
entry also needs its `period`, which says how GIBS names its frames: by date for a
frame a day, to the second for a shorter step.

**A provider is one frame source** (`FrameSource` in `FramedImagery.ts`): a layer's
list of frames, and Cesium's provider for one frame. `gibsFrames` reads the layer's
WMTS time domain and draws its Web Mercator tile set. `eumetViewFrames` reads the
layer's own WMS capabilities, which give its frames and its bounds, and draws
512-pixel geographic tiles inside those bounds. What follows the clock knows neither
service.

**A drawn layer is named `provider:layer`**, in the store
(`cesium.instrumentImagery`) and in the url, `imagery=gibs:GOES-East_ABI_GeoColor`
(ADR 0001). The name is the layer's, not a satellite's instrument's: a layer two
satellites share is one layer.

**The layer is drawn from the entry of whichever loaded record carries it.** The url
holds no tile set, and there is no table of layers beside the records (ADR 0019), so
`sceneSync` looks the name up among the catalog's entries each time the catalog
changes. A name no loaded record carries loads every group, as a `sats=` name the
catalog lacks does: its satellite may be in a group the route leaves out. Once every
group has loaded, a name that is still no record's drawable layer leaves the list and
the url: it is mistyped, or its entry left the manifest. A name given twice is drawn
once.

**It is shown from the Imagery tab and taken off there or in the Map panel.** The tab,
after Instruments, has a card for each entry: the instrument, a picture of the layer,
when it has frames, a Show switch where the globe can draw it, and the link. A press
anywhere else on such a card does what the switch does. An
instrument with imagery has a button in the Instruments tab that opens the tab at its
cards. The Map panel lists every layer under its overlays, in groups, the one with a layer on
opened first, so a layer can be taken off without finding its satellite again (ADR 0021).

**The picture is one WMS GetMap of the latest frame**, around where the satellite was
when it was selected, so it does not reload as the satellite moves: yesterday's for a
daily GIBS layer, whose today is still filling in, and the last frame of one that
stopped. It is not the clock's frame, which would mean listing the layer's frames for
every card. A Copernicus Browser dataset has no WMS open to the app, and no picture.

Listing the imagery under each instrument's facts, as ADR 0019 had it, buried the one
imager among a geostationary satellite's eight instruments, and a spec sheet, a
spectrum chart and toggles above the tabs were tried against the tab of cards (the
`prototype/instrument-imagery-display` branch).

**It lies over the basemap and under the overlays**, the last one shown on top.
Several may be drawn: GOES-East and GOES-West together are two discs. A layer that
follows the clock is on the globe only once its service has listed its frames, so the
controller places each layer over the nearest one below it that is there yet.

**Showing a layer reloads nothing else.** The controller adds and removes each
instrument layer by itself: the basemap is not rebuilt, a layer already drawn stays
while another is shown or taken off, and a change in the Map panel leaves the
instrument imagery on the globe.

**It follows the clock as one Cesium layer a frame** (`FramedImagery.ts`). The frame
for the clock loads as a layer of its own over the one before it, which is taken off
once the new one's own tile requests are answered, or sooner when the globe has
nothing left to load. The globe's word alone would not do: it waits for the terrain
and every other layer, which never ends while the view keeps moving. After 20 seconds
the new frame is shown as far as it got. A frame that is loading is finished before a
newer one starts, so a clock that runs faster than frames load still shows frames,
skipping some; it is given up only when the clock returns to the frame that is shown. The Map panel's `VIIRS` basemap follows the clock the same way,
from the same GIBS frame source.

## Consequences

- **20 of the 27 entries can be drawn**: GIBS's 11 and EUMETView's nine. The
  Copernicus Browser's seven stay links.
- **A polar EUMETView layer has a frame an orbit**: Sentinel-3's OLCI is the one
  swath, with the rest of the globe empty; Metop's AVHRR/3 the last six orbits stacked.
- **Outside its history a layer shows its first or last frame.** One that stopped
  therefore shows its last frame at today's clock; the entry's text beside the button
  says when it ended, the globe does not. A daily GIBS layer leaves out its newest
  day while that may still be filling in, two days from its start.
- **A service that cannot list its frames shows its latest one** and is asked again
  every minute; a daily GIBS layer shows yesterday meanwhile, since its latest day is
  the one still filling in.
- **A frame change costs a second layer while it loads**, and its tiles are asked for
  twice where the view moves meanwhile: the old frame's and the new one's.
- **Cesium's own preloading of the next frame is lost**, which its time-dynamic
  provider does as the clock nears it.
- **GIBS's GeoColor layers list only the frames they still serve**, 90 days, so the
  entry's `window` is not needed to keep the clock inside them.
- **A link with `imagery` loads every group at once**, before the route's own groups
  could have answered.
- **The native app draws none of it yet** and ignores the two fields. Its Imagery tab
  has the same cards, pictures included, without the switch.
- **The Map panel's `GOES-IR` overlay is gone.** It was one infrared band of
  GOES-East, with the fault above every 10 minutes; GOES-East's GeoColor entry shows
  the same disc by day and night. A link that names it loses it, as it would any
  unknown layer. `VIIRS` stays, from the registry: the layer of NOAA-20's entry,
  drawn as a basemap.

## Alternatives rejected

- **The names added to `layers`.** Its grammar ends a name at `_` for the opacity, and
  GIBS's ids are full of them; and its vocabulary is closed, checked at parse time.
- **`satellite:instrument` in the url.** Names an entry list, not a layer, and breaks
  when a service changes hands.
- **A table of drawable layers in the frontend, or in the group index.** A second copy
  of what the records carry, or a metadata endpoint by another name.
- **One layer at a time.** Simpler, but showing GOES-West would hide GOES-East.
- **Cesium's time-dynamic provider**, as the Map panel's `VIIRS` and `GOES-IR` used
  it. The first version. On a frame change Cesium empties the layer's tile cache, so a
  globe tile made while the new frame loads, by a zoom, has no parent tile to draw:
  measured, 13 of 19 tiles in view showed the basemap for as long as the frame took to
  load, and a clock run fast never let them settle.
- **One time-dynamic provider shared by the services**, each giving its frames and
  its provider. It shares the thing with the fault above.
- **EUMETView's WMTS.** Its tile sets would have to be read per layer and its time
  wants milliseconds; the WMS draws a tile of any size in either projection, takes the
  time as GIBS writes it, and lets a tile be cached for a week.
- **EUMETView's bounds in the manifest.** The capabilities that list the frames give
  them, in the same answer.
- **A nested `draw` object per entry.** The two fields describe any tile pyramid, and
  every other field of an entry is flat.

## Open questions

- **Which frame is on the globe?** Nothing says so: a daily layer shows the newest
  finished day, and a layer that stopped its last one.
- **JMA** needs a frame source of its own: XYZ tiles and its list of frames.
- **Whether EUMETView's WMTS is kinder to the service** than a WMS tile drawn on
  request: not measured. No rate limit is published for either.
- **Each provider's credit for a foreign source**: GIBS asks for NOAA's beside its own
  for a GOES layer, and EUMETView's Sentinel-3 layers are Copernicus data. A layer
  shows its provider's line only.
