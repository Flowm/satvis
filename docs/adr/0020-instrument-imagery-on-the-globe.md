---
status: accepted
---

# Instrument imagery on the globe

A record says which provider's layer shows an instrument (ADR 0019), and the
Instruments tab links it. The same entry is enough to draw the layer on the globe at
the clock's time, as the Map panel's `VIIRS` and `GOES-IR` layers already are
(`GibsTimeLayer.ts`). What was missing: which tiles a layer has, how a drawn layer is
named in the url, and where it sits among the Map panel's layers.

## Decision

**An entry the globe can draw carries its tile set**: `maxLevel`, the deepest level of
its tiles, and `format`, their type. For GIBS they are the N of the layer's
`GoogleMapsCompatible_LevelN` set and `png` or `jpeg`, read from its capabilities; the
layer id says neither. An entry without them is a link only.

**GIBS first, on the web.** `drawnImagery` in `src/config/instrumentImagery.ts` reads
what the globe needs of an entry, and gives nothing for another provider or for a step
the time layer does not know: it draws a frame a day or one every 10 minutes, which is
every GIBS entry the manifest has.

**A drawn layer is named `provider:layer`**, in the store
(`cesium.instrumentImagery`) and in the url, `imagery=gibs:GOES-East_ABI_GeoColor`
(ADR 0001). The name is the layer's, not a satellite's instrument's: a layer two
satellites share is one layer.

**The layer is drawn from the entry of whichever loaded record carries it.** The url
holds no tile set, and there is no table of layers beside the records (ADR 0019), so
`sceneSync` looks the name up among the catalog's entries each time the catalog
changes. A name no loaded record carries loads every group once, as a `sats=` name the
catalog lacks does: its satellite may be in a group the route leaves out.

**It is shown from the Instruments tab and taken off there or in the Map panel.** Each
entry the globe can draw has a button beside its link. The Map panel lists what is
drawn under its overlays, by label and satellite, "GeoColor · GOES 19", so a layer
can be taken off without finding its satellite again.

**It lies over the basemap and under the overlays**, the last one shown on top.
Several may be drawn: GOES-East and GOES-West together are two discs.

**Showing a layer leaves the Map panel's layers alone.** The controller adds and
removes instrument imagery by itself, so the basemap is not rebuilt.

**It follows the clock as one Cesium layer a frame** (`FramedImagery.ts`). The frame
for the clock loads as a layer of its own over the one before it, which is taken off
once the globe has all of the new one's tiles. A frame that is loading is finished
before a newer one starts, so a clock that runs faster than frames load still shows
frames, skipping some.

## Consequences

- **11 of the 27 entries can be drawn**: every GIBS one. EUMETView's nine and the
  Copernicus Browser's stay links.
- **Outside its history a layer shows its first or last frame.** One that stopped
  therefore shows its last frame at today's clock; the entry's text beside the button
  says when it ended, the globe does not.
- **A frame change costs a second layer while it loads**, and its tiles are asked for
  twice where the view moves meanwhile: the old frame's and the new one's.
- **Cesium's own preloading of the next frame is lost**, which its time-dynamic
  provider does as the clock nears it.
- **The Map panel's `VIIRS` and `GOES-IR` still use the time-dynamic provider**
  (`GibsTimeLayer.ts`) and still lose their tiles on a zoom during a frame change.
- **GIBS's GeoColor layers list only the frames they still serve**, 90 days, so the
  entry's `window` is not needed to keep the clock inside them. `GOES-IR`'s domain
  lists frames back to 2019 that answer 404; it is not an entry yet.
- **A link with `imagery` loads every group at once**, before the route's own groups
  could have answered.
- **The native app draws none of it yet** and ignores the two fields.
- **The Map panel's `VIIRS` and `GOES-IR` stay as they are.** `VIIRS` is NOAA-20's
  entry drawn as a basemap; `GOES-IR` is a single band, which the manifest does not
  list.

## Alternatives rejected

- **The names added to `layers`.** Its grammar ends a name at `_` for the opacity, and
  GIBS's ids are full of them; and its vocabulary is closed, checked at parse time.
- **`satellite:instrument` in the url.** Names an entry list, not a layer, and breaks
  when a service changes hands.
- **A table of drawable layers in the frontend, or in the group index.** A second copy
  of what the records carry, or a metadata endpoint by another name.
- **One layer at a time.** Simpler, but showing GOES-West would hide GOES-East.
- **Cesium's time-dynamic provider**, as `GibsTimeLayer.ts` uses it for the Map panel.
  The first version. On a frame change Cesium empties the layer's tile cache, so a
  globe tile made while the new frame loads, by a zoom, has no parent tile to draw:
  measured, 13 of 19 tiles in view showed the basemap for as long as the frame took to
  load, and a clock run fast never let them settle.
- **A nested `draw` object per entry.** The two fields describe any tile pyramid, and
  every other field of an entry is flat.

## Open questions

- **Which frame is on the globe?** Nothing says so: a daily layer shows the newest
  finished day, and a layer that stopped its last one.
- **EUMETView and JMA** need their own time layers: EUMETView's WMTS wants a time with
  milliseconds and snaps to the nearest frame without saying which.
- **Each provider's credit for a foreign source**: GIBS asks for NOAA's beside its own
  for a GOES layer. The layer shows GIBS's line only.
