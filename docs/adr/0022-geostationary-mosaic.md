---
status: accepted
---

# The geostationary mosaic as a basemap

The georing-mosaic project joins one hour's scans of GOES-East, GOES-West, Meteosat at
0° and Himawari into one picture of the Earth, day and night, and publishes it hourly to
`https://s.satvis.space/geo/`: a cloud-optimized GeoTIFF (COG) a Slot, kept for 7 days,
and a static STAC catalogue that lists them. Its `docs/plan.md` fixed the file for this
reader: Web Mercator to zoom 8, 512-pixel WebP blocks aligned to the web tile grid at
every overview level, and no tile service in front of it.

## Decision

**A basemap of the Map panel, `GeoMosaic`, that follows the clock** as instrument
imagery does (ADR 0020): one Cesium layer a frame (`FramedImagery.ts`), the Slot at or before the
clock's time. Not instrument imagery: it is no one satellite's.

**The browser reads the COG itself, one range request a tile** (`CogImageryProvider.ts`,
on `@cogeotiff/core`). A Cesium tile at level z of 512-pixel Web Mercator tiles is one
block of the TIFF image that is 512·2^z pixels wide, so nothing is resampled or
stitched. The header is one 16 kB read a frame. A level's tile offsets and byte counts
are read whole the first time the globe wants that level, 4 bytes each per tile (128 kB
at the deepest level), so every tile after that is one request. Read lazily, as the
library does by default, each tile would cost three: its offset, GDAL's size leader and
its bytes. A tile the file leaves empty (sparse, poleward of what any satellite sees)
is discarded, and Cesium draws the parent's.

**The frames are the STAC collection's items** (`mosaic/collection.json`), the clock
showing the Slot at or before it. Each item link carries the item's `datetime`, added
for this reader, so the collection alone gives the Slots; a link without one is not
shown. The collection is served `no-cache`, and asked again 10 minutes after the last
read while the clock is past the newest Slot.

**The frame on the globe reads its own item**: the COG is the item's cloud-optimized
asset, and the credit its `georing:attribution` lines, which name only the satellites
that took part. One small request a frame, before its header. Where the collection
cannot be read, `latest.json` names the item to show.

## Consequences

- **The bucket must answer cross-origin requests**, with `Range` among the allowed
  headers. Without a CORS policy on it the layer draws nothing and warns in the console.
- **A frame reads its own item, header and indexes**: changing the hour reloads them,
  and the first frame at a level costs its index before its tiles.
- **The link's `datetime` is a contract with the producer**: georing-mosaic writes it
  there for this reader.
- **Transparent where no satellite sees**: the polar caps and, where the plan's India
  seam leaves a gap, part of the Indian Ocean. A basemap is alone (CONTEXT.md, "Basemap
  and overlay"), so the globe's own colour shows there.
- **A Slot rebuilt after a late Disk** keeps its name; a frame already drawn keeps the
  first build until the clock leaves it.
- **The native app reads it the same way** (`ios/SatvisKit/Sources/SatvisRender/Mosaic.swift`),
  with a TIFF reader of its own, as no system framework reads a COG by ranges. With no
  CORS to answer, the bucket's policy does not reach it. Over its own Natural Earth,
  which it draws under every base map, the polar caps show that rather than the
  globe's colour; and with no `latest.json` fallback, a collection that cannot be
  read is asked again a minute later, Natural Earth showing meanwhile.

## Alternatives rejected

- **A tile endpoint on the Worker** that cuts the COG into XYZ tiles: rejected in the
  georing plan. The COG's blocks already are the tiles.
- **Cesium's time-dynamic provider**: the fault in ADR 0020, its cache emptied on each
  frame change.
- **The collection's temporal extent and an hourly step as the list of frames**: an
  hour between its ends may never have been built.
- **Each item's own `datetime`**: a request per item, up to 168 for the week kept.
- **The Slot read from the item's name** (`georing_mosaic_20261113T0300Z.json`): the
  first version, before the links carried the time. A second, unwritten contract.
- **The COG's path made from the Slot**: the item's asset says where the file is.
