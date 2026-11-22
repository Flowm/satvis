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

A throwaway prototype settled the design over five rounds; its variants and the verdict are
on the branch `prototype/imagery-menu-clarity` (commit `fd681c4a`).

## Decision

**Every layer has a type, named for what the user sees** (`imageryType` in
`src/config/instrumentImagery.ts`): Passes (a granule layer), Daily mosaic, Latest orbits
(Metop's stacked orbits), Live view (a geostationary imager's frames), World mosaic (a
composite the globe draws) and Scene archive (a composite of viewer links alone). The type,
not the picture's colours, tells two layers of a satellite apart. "Recorded swath" is gone
from the interface; the glossary keeps it for the layer itself.

**A layer is said in the same slots, in the same order, everywhere** (`imageryWords`):

1. the type, a card's title;
2. the picture: its colours, then the instrument, "True colour · MODIS". The colours are
   always named, true colour too, so every card reads alike; the label's qualifier stays
   where it says something of the picture ("nadir camera", "Europe"), not where the type's
   title says it already ("six orbits stacked", a composite's "GeoRing");
3. how often it updates, or the day it ended: "Once a day", "Every 10 min", "With each
   pass, hours behind live";
4. how far back it goes: "Back to 2002", "The last 90 days".

**The Imagery tab shows the first two and the picture's freshness; the rest is behind an
info button.** A card is its picture, captioned with how fresh it is ("Yesterday", "Newest
pass, 3 h ago", in amber "Last day, Jun 19, 2026"), the type with its icon, and the picture
line. The info button opens updates, archive and the viewer link. A layer the globe cannot
draw shows its viewer link beside the button, as that is its only action. Cards of layers
that ended come last. The instrument badge over the picture is gone: the picture line names
the instrument.

**The Map panel's LEO group has a row per satellite, without the instrument**
(`imageryRowsBySatellite`). Its layers are buttons named by their type's short name,
"Daily", "Orbits", or by the instrument where a satellite has two of a type (PACE's
"SPEXone"). What shows at once comes first, the passes last. The satellite's name opens its
Imagery tab, which replaces the row's image button. The group's count is its satellites.

**The passes start as a replay.** Off, the passes button is an action, dashed and with a
play icon, that says how old the newest pass is ("▶ 3 h ago"). A press turns the layer on,
sets the clock five minutes before the newest pass with pixels (`REPLAY_LEAD_MS`) and opens
the satellite's Imagery tab. On, it is a switch like the others. The recorded swath is still
a layer, not a mode (ADR 0023): the clock stays where the replay put it, and the layer
follows it from there.

**A passes layer that is on with the clock past its newest pass says so in one line**
(`PassNotice.vue`), under its row and on its card: "Newest pass 3 days ago" and a Go button
that sets the clock as the replay does. The menu and the tab share the lookup of the newest
pass (`useLatestPasses.ts`); the menu asks only while the LEO group is open.

## Consequences

- Opening the LEO group asks CMR or EUMETSAT's Data Store for each satellite's newest pass,
  and the providers for whether it has pixels: about a dozen catalogue queries and a few WMS
  requests each, again every ten minutes while it stays open.
- The GEO group keeps its rows of ADR 0021: a geostationary satellite has one layer type, so
  rows by satellite would name its layers by their colours again.
- The records' `imagery` is unchanged. The Imagery tab's entries carry `type` and `words`;
  the parity fixtures have them, and the native app, which decodes only the fields it knows,
  still names its rows and cards as ADR 0021 does.

## Alternatives rejected

- **Grouping the LEO layers by type**, a section each with the satellites as chips. Compact,
  but a satellite's layers were apart, and the chips hid which satellites were on.
- **A row per satellite that opens a drawer** of its layers, each said in a sentence. Every
  look took a press, and the drawer broke the panel's card.
- **The passes as a switch that shows its age** ("Passes · 3 h"). It still turned on to
  nothing near live; an action that goes to the newest pass does what the user wanted.
- **The tab's slots always visible**, as three lines or as a labelled grid. Every card then
  carried its archive, the fact asked for least; the grid was the most text for the least.
- **One big picture with the layers as segments.** It hid all but one layer, and the layers
  of a satellite are few enough to see side by side.
