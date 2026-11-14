---
status: accepted
---

# The imagery manifest: which provider's layer shows which instrument

A record says which instruments a satellite carries (ADR 0018), but not where to see
what they observe. Public services hold that imagery as layers: NASA GIBS has 87 colour
layers that are each one instrument's picture, EUMETView 39. Saying "this is MODIS on
Terra, daily since 2000" needs a join from an instrument on a satellite to a layer of a
provider, and the first use of it is a link.

No provider publishes that join. In November 2026 each was asked for one
(`docs/proposals/imagery-availability.md` has the survey):

- **GIBS** names a layer's satellite and instrument in its layer metadata, as free
  text, and for a geostationary layer names the position: "GOES-East".
- **NASA's own chain**, CEOS instrument to GCMD keyword to CMR collection to GIBS
  layer, reaches 19 of the 740 served instruments, and some of those wrongly, with
  nothing to say which.
- **EUMETView** names a layer `workspace:name`. The workspace is a service
  (`msg_fes`, Meteosat's SEVIRI service at 0°), not a satellite.

## Decision

**The imagery manifest is hand-written**, as a model manifest is (ADR 0007):
`worker/src/config/satvis.imagery.yaml`. `generate-groups` reads it and gives each
satellite an `imagery` field through the satellite table. The schema is
`ImageryManifest` in `worker/src/gp/types.ts`.

**The manifest is written as the record is read: a satellite, its instruments, each
one's imagery.** A satellite is named by NORAD id, an instrument by its CEOS short
name, and an entry spells out its provider, its layer and the rest, a field a line.
A layer that shows several satellites is a **composite**, listed once under
`composites` with the satellites it shows, each with its instrument and the day it took
over its position. The build gives each of them the entry, `merged`, after its own; a
record reads as before. A layer listed in two places fails the build.

**A layer named for a service is listed under the satellite that provides it now.**
GOES-East is GOES-19's, and Meteosat has two services at 0°: the full disc of the
third generation's FCI, which is Meteosat-12's, and the second generation's SEVIRI
service, which Meteosat-10 runs on beside it. Where such a layer has earlier frames,
its entry's `start` is the day its satellite took the service over, from the
operator's notice: those frames are another satellite's.

**A record carries the provider and the layer, never a url**, as it carries a model's
file and not where models are served:

```json
"imagery": [
  { "instrument": "ABI", "provider": "gibs", "layer": "GOES-East_ABI_GeoColor", "label": "GeoColor",
    "kind": "rgb", "period": "PT10M", "window": "P90D" }
]
```

- `label` says what the picture is. `kind` is `rgb`, the only one so far.
- `period` is the step between frames, `start` the satellite's first frame, `end` the
  last frame of a layer that stopped, `window` a rolling history: GIBS keeps a
  geostationary layer 90 days, whatever its time domain lists. A later slice that draws
  the layer needs them as much as the panel does.
- `merged` on a record's entry where it shows other satellites too: a composite's. A
  layer that covers less than the instrument sees says so in its label: "Natural colour,
  Europe"; a composite's label names what it covers: "Natural colour, GEO ring".
- An instrument's first entry is its default.
- `maxLevel` and `format` came later, with drawing the layer (ADR 0020).

**`imagery` is curated only, and stands beside `instruments`**, not inside it, so
CEOS stays the one owner of that list (ADR 0008). A row of a config may not give it:
the manifest is its only source.

**Each app has a table of the providers it knows**: the viewer's name and how a layer
becomes a link to it (`src/config/instrumentImagery.ts`; the native app reads the same
table from `web-tables.json`). An entry of a provider an app does not know is left
out, so a new provider breaks no released app.

**Imagery shows under its instrument, and the refresh warns where there is none.**
Both apps list an entry under the instrument it names, so one whose `instrument` is
not among the satellite's `instruments` shows nowhere. The record still carries it,
and the refresh log names it: an instrument CEOS renames shows as a warning and a
missing link, not as imagery under the wrong name.

**A provider's layer shows a satellite's instrument once.** Two entries that claim it
fail the build, naming both, as two models for one satellite do.

**The Instruments tab lists an instrument's imagery under its facts**, each entry as
a link to the layer in the provider's own viewer, the default first: "GeoColor, every
10 min, last 90 days · NASA Worldview". Nothing is fetched and nothing is drawn.
ADR 0020 since draws them, and moved them to an Imagery tab of their own.

**A layer is listed when it is the picture of an instrument that people look for
first, and its provider states a licence for it**: its true colour or natural colour,
and the day-and-night blend a provider makes of it, GeoColor, which comes first where
there is one. GIBS and EUMETView have 126 colour layers that are one instrument's.
The 106 not listed are variants of the same picture (enhanced, surface reflectance,
MISR's eight other cameras) and the false colour and weather composites; they wait
until someone asks for them. GIBS is NASA's, free to use with credit; everything on
EUMETView is CC BY 4.0 (EUMETSAT Data Policy, Annex II). The Copernicus Browser's
datasets are listed as links only: a link out needs no grant, and a dataset there is
the whole constellation's.

## Consequences

- **21 satellites carry 27 entries** for 24 instruments: 11 layers of GIBS, 9 of
  EUMETView and 3 datasets of the Copernicus Browser, which 7 satellites share.
- **The served payloads grow by under 1 KB gzip**, on 578 KB.
- **Himawari-9 and NISAR have none.** GIBS's only colour layers of them are an air
  mass composite and a radar false colour.
- **Six services are assigned by hand**: GOES-East and GOES-West, and Meteosat's
  four. No source says who provides one, so a handover is noticed by whoever reads
  the operator's notices. The layer keeps working; it is credited to the old
  satellite until its entries are moved.
- **A layer that stops is not noticed either.** Suomi NPP's stopped on 2026-11-02,
  when NOAA ended the satellite's science data, and GIBS's capabilities list it as
  before. Its `end` was written by hand.
- **Without a stored CEOS table no imagery is shown**, since nothing has instruments.
  The refresh says so in one line.
- **The native app shows the same**, in an Imagery tab of its own since ADR 0020.
  Its `SatelliteDetails` is held to `getSatelliteInfo` by the parity fixtures, which
  carry the manifest's entries for Metop-C and GOES 19, and its preview urls to
  `imageryPreviewUrl`. The rest of what an entry can say is held by unit tests
  written twice, one case for one.
- **`imageryProviders` in `CesiumLayerProviders.ts` is another thing**: the Map
  panel's basemaps and overlays.

## Alternatives rejected

- **The entries inside each instrument of `instruments`.** Two owners of one field,
  which ADR 0008 rules out, and a CEOS refresh would have to carry them over.
- **Rows in `satvis.core.yaml`**, one per satellite, beside its swath and its mission
  type. The imagery of 21 satellites would bury the table's other rows.
- **A manifest per plugin too**, as models have. No plugin has imagery to list, and one
  of a provider the apps do not know would show nothing.
- **The refresh dropping an entry whose instrument the satellite lacks.** The apps
  already show no such entry, so it only added a second place that decides it.
- **A table of slots**: a position or service by name, with its holder and its
  layers, which the generator gave to the holder. One line to change at a handover,
  but a second kind of entry and a name to explain, for six services of one or two
  layers each. A satellite provides the service at any time, so its layers are listed
  under it.
- **A table in the frontend, keyed by NORAD id.** Written twice, web and native, and
  not attached at refresh time (ADR 0002).
- **An upstream table built from GIBS's layer metadata and CMR.** 19 rows, some wrong,
  and nothing for any other provider.
- **A url per entry.** A viewer that moves, or an app that draws the layer itself,
  would need every record rewritten.
- **The manifest written by layer**, in blocks of a provider, what its layers show,
  and the layers. Compact for 126 layers, but a satellite's imagery lay in one section
  per provider, and which entry was an instrument's default depended on the order of
  those sections.
- **Each satellite's copy of a merged layer**, the first form. Rejected on 2026-11-14,
  when the geostationary rings came: EUMETSAT's is one entry under five satellites and
  the georing mosaic's under four, a handover moved five copies, and nothing held the
  copies alike. The section of composites it had beaten, as a third kind of entry for
  three datasets, took its place.
- **Every colour layer a provider has of an instrument**: 14 for VIIRS, 20 for MISR,
  133 entries in all, most of them composites few would look for.
- **A `since` beside `start`**, the handover day apart from the layer's first frame.
  The panel printed the later one, and nothing needs the earlier: a provider's
  capabilities give it.
- **A `region` field and a fold for an instrument's further entries.** One layer is
  regional and no instrument has more than two entries.
- **Single bands and derived products too.** GIBS alone has ten times as many, which
  is the point at which records would refer to layers served once.

## Open questions

- **Who notices a handover or a stopped layer?** A script that compares the manifest
  with each provider's capabilities would catch a layer that is gone, a changed step
  and a newest frame that is old. It cannot see a handover.
- **Sentinel-1 has no entry.** Its picture in the Copernicus Browser is radar
  backscatter, which `rgb` does not describe; it waits for a second `kind`.
- **Sentinel-3C has no entry.** CEOS gives it an OLCI, but it is served under a
  provisional catalog number, which an entry cannot be keyed on, and whether the
  Browser's dataset holds its scenes yet was not checked.
- **A handover does not shorten a rolling history.** A satellite that took a service
  over 40 days ago still reads "last 90 days": a layer with a `window` has no `start`,
  and saying otherwise needs today's date, which the panel's text does not depend on.
- **The Copernicus Browser opens behind its own consent dialog**, so that the link
  lands on the dataset was checked only as far as the address it keeps.
