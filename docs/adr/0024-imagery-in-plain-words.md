---
status: accepted
---

# Instrument imagery in plain words: a type per layer, the same slots on every card

The Map panel's LEO group and the Imagery tab named a layer by mixing several of its
properties: the satellite, the instrument, the picture shortened ("True", "Natural + fog")
and, for a granule layer, how it was made ("Recorded swath"). A satellite with a daily
layer and a granule layer had two rows that read like two colour products, though both were
true colour and differed in how they show. A card's title was the picture's colours for
one layer and "Recorded swath" for the other, and its most prominent date ("daily since
2002") answered a question few ask. The recorded swath also showed nothing when turned on
near live, as its newest pass is hours to days old (ADR 0023), which read as broken.

Three throwaway prototypes settled the design; their variants and verdicts are on the
branches `prototype/imagery-menu-clarity` (commit `fd681c4a`, the words and the tab),
`prototype/imagery-menu-rows` (commit `4229359b`, the Map panel's rows) and
`prototype/imagery-mosaic-naming` (commit `9ccdd633`, the mosaics).

## Decision

**Every layer has a type, named for what the user sees** (`imageryType` in
`src/config/instrumentImagery.ts`): Passes (a granule layer), Daily mosaic, Latest orbits
(Metop's stacked orbits), Live view (a geostationary imager's frames), World mosaic (a
composite the globe draws, `mosaic` in code) and Scene archive (a composite of viewer links alone). The type,
not the picture's colours, tells two layers of a satellite apart. "Recorded swath" is gone
from the interface; the glossary keeps it for the layer itself.

**A layer is said in the same slots, in the same order, everywhere** (`imageryWords`):

1. the type, a card's title;
2. the picture: its colours, then the instrument, "True colour · MODIS", or for a
   composite, which is no one instrument's, who joined the pictures: "Day/Night · by
   satvis", "Natural colour · by EUMETSAT" (the provider's `maker`). The colours are
   always named, true colour too, so every card reads alike; the label's qualifier stays
   where it says something of the picture ("nadir camera", "Europe"), not where the type's
   title says it already ("six orbits stacked", a composite's "GeoRing");
3. how often it updates, or the day it ended: "Once a day", "Every 10 min", "With each
   pass, hours behind live";
4. how far back it goes: "Back to 2002", "The last 90 days";
5. for a passes layer whose pictures are cut from frames that hold other passes, where it
   comes from: "Cropped from the daily mosaic", whose picture of a place may be another pass
   of the day (where the passes overlap near the poles) or, for HLS, the other satellite of
   the pair; "Cropped from the latest orbits", Metop's six orbits stacked, where an older
   orbit shows through. Sentinel-3's swaths and GIBS's granule layers are a pass or a
   granule a frame, and say nothing here.

**The Imagery tab shows the first two and the picture's freshness; the rest is behind an
info button.** A card is its picture, captioned with how fresh it is ("Yesterday", "Newest
pass, 3 h ago", in amber "Last day, Jun 19, 2026"), the type with its icon, and the picture
line, which also name the card for a screen reader. The info button opens updates, archive
and the viewer link. The fifth slot is on the card, under the picture line, as it says what
the picture on the card and the globe is. A layer the globe cannot draw shows its viewer link beside the button,
as that is its only action. Cards of layers that ended come last. The instrument badge over the picture is gone: the picture line names
the instrument.

**Both of the Map panel's groups have a row per satellite, without the instrument**
(`imageryRows`). Its layers are buttons named by their type's short name, "Daily",
"Orbits", "Live"; what shows at once comes first, the passes last. The satellite's name
opens its Imagery tab, which replaces the row's image button. A group's composites of a type
are one row, first, named by the type as their cards are, with a button each named by its
picture: "World mosaic [Day/Night] [Natural]". Its name opens the menu of their satellites.
"GeoRing", the composites' qualifier in the manifest, is not shown. A group's count is its
rows.

- A satellite's second layer of a type (PACE's SPEXone, Meteosat-12's true colour beside
  its GeoColour) is in its Imagery tab and not its row, unless it is on, so that a row fits
  one line and can still take off what is on. Its button is named by its instrument, or by
  its colours where the instrument is the same.
- The groups and their rows appear once every group has loaded, with a note under the title
  until then: groups, counts and rows arriving one by one moved those already shown. A layer
  that is on has a plain switch meanwhile, so it can still be taken off.
- No legend: the buttons' names and their tooltips (the card's type, picture and updates)
  say what they are.

**The passes button is a switch like the others.** A press shows the layer and leaves the
clock where it is. Its name is fixed and its icon is the type's, as on every button; how old
the newest pass is is in its tooltip, as a name that changed when the answer came made every
row's buttons move.

**A passes layer that is on with the clock past its newest pass says so in one line**
(`PassNotice.vue`), under its row and on its card: "Newest pass 3 days ago" and a Go button
that sets the clock five minutes before the newest pass with pixels (`REPLAY_LEAD_MS`). The
notice, the button's tooltip and the card's caption all say the age of that pass, the one Go
goes to, not of a newer one by night or one GIBS left out, and say it again every minute. The
clock moves only from there, where the notice has said why. The recorded swath stays a layer,
not a mode (ADR 0023). The menu and the tab share the lookup of the newest
pass (`useLatestPasses.ts`); the menu asks only for the open group, once the list has loaded.

**Our own mosaic names satvis as its source.** The georing-mosaic project's mosaic has no
viewer; its cards' source is "satvis", linking to https://github.com/Flowm/georing-mosaic, and
it stays apart from EUMETSAT's natural colour mosaic: two layers, two sources, one row.

## Consequences

- Opening the LEO group asks CMR or EUMETSAT's Data Store for each satellite's newest pass,
  and the providers for whether it has pixels: about a dozen catalogue queries and a few WMS
  requests each, again every ten minutes while it stays open.
- The records' `imagery` is unchanged. The Imagery tab's entries carry `type` and `words`;
  the parity fixtures have them, and the native app, which decodes only the fields it knows,
  still names its rows and cards as ADR 0021 does, composites by "GeoRing". It does show our
  own mosaic's new source, satvis and the repository link, which it reads from
  `web-tables.json`.

## Alternatives rejected

- **Grouping the LEO layers by type**, a section each with the satellites as chips. Compact,
  but a satellite's layers were apart, and the chips hid which satellites were on.
- **A row per satellite that opens a drawer** of its layers, each said in a sentence. Every
  look took a press, and the drawer broke the panel's card.
- **The passes as a switch that shows its age** ("Passes · 3 h"). The age on the button
  resized it, and moved the row, as each answer came seconds after the rows.
- **The passes button as a replay**, dashed and with a play icon, that turned the layer on,
  set the clock before the newest pass and opened the Imagery tab. A press that moved the
  clock without saying so surprised; the notice says why before its Go button does it. The
  play icon also changed to the passes icon once on, one button with two marks.
- **The GEO group's rows of ADR 0021 beside the LEO group's buttons.** The two groups looked
  like two different lists for one kind of thing.
- **A grid with a column per type**, icon-only buttons and the column heads as the legend.
  The tidiest, but icons alone named nothing.
- **Checkbox rows under a heading per satellite**, as the panel's other switches. The longest
  list, with "Live view" repeated on every geostationary satellite.
- **The mosaics named by their picture** ("Day/night mosaic") **or by their maker** ("satvis
  mosaic"), a row each. The first broke the rule that a card's title is its type; the second
  said least of what the picture shows.
- **A legend over the LEO rows.** It sat apart from the rows it explained, and the buttons'
  names say it.
- **The tab's slots always visible**, as three lines or as a labelled grid. Every card then
  carried its archive, the fact asked for least; the grid was the most text for the least.
- **One big picture with the layers as segments.** It hid all but one layer, and the layers
  of a satellite are few enough to see side by side.
