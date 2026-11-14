---
status: accepted
---

# Finding instrument imagery from the catalog and the Map panel

Instrument imagery (ADR 0019, 0020) was reachable from one place: a satellite's
Imagery tab. Nothing said which satellites have imagery, what their instruments sense,
or which layers the globe can draw, without first knowing the satellite. The records carry
all of it: `instruments` with each one's kind and bands (ADR 0018), and `imagery`.

A throwaway prototype settled the design over several rounds; its nine variants and the
verdict are on the branch `prototype/imagery-accessibility` (commit `71e17348`).

## Decision

**A bands chart in the catalog sheet, filtering bands alone.** Below the four hero charts,
across both columns: one bar per CEOS waveband class, in wavelength order under optical,
thermal, microwave and radar, in the Instruments tab's band colours (`wavebands.ts`), on a
square-root scale (VIS has about 150 satellites,
W-Band one). The optical and thermal bands always show; a radar band only where some
satellite has it. A click picks a band, as a facet value.

**A Data availability facet: what satvis has for a satellite.** Imagery, imagery as a map
layer, imagery as a viewer link only, CEOS instruments and a 3D model. It takes the
3D model facet's place (ADR 0012).

- Picks are all-of, not one-of as in every other facet: imagery and a 3D model asks for
  satellites with both. A value's count is then what adding it would leave, not what it
  has under the other filters (`matchAll` in `src/modules/catalogFacets.ts`).
- "Imagery" is listed beside its two kinds rather than being a tree over them: a tree's
  parent picks its leaves, which under all-of would ask for both kinds at once.
- The two kinds part the satellites with imagery, as the list's column does: a map layer
  where the globe can draw one, else a viewer link only. Every entry has a viewer link, so
  "in its provider's viewer" would have been Imagery again.
- Its bars are on a square-root scale: about 13,700 satellites have a 3D model, 21 imagery.
- The catalog, the Map panel and the Imagery tab read an entry alike (`readImagery`), so
  they agree on which satellites have imagery.

**An Instrument kind tree.** CEOS names about 45 kinds; they fold under ten families
(optical imagers, microwave radiometers, radar, lidar, spectrometers and sounders,
lightning, Sun and Earth radiation, space environment, positioning and gravity, data and
communications), by the patterns in `KIND_FAMILIES`. A kind CEOS leaves empty or gives as
"TBD" or "Other" is "Not stated", under "Other".

- A satellite counts once under a family however many of its kinds the family has. The
  crossfilter counts every tree's parents itself (`parentCounts`); summing the leaves
  counted a satellite with two optical imagers twice.

**An imagery column in the list**, last, beside the info button: the image icon the
Instruments tab marks an instrument with, strong where the globe can draw a layer and faint
for a link alone. Most rows are empty, so it sits at the end rather than parting the name
from the orbit. It sorts the satellites with imagery first, and a press on a mark selects the
satellite at its Imagery tab, as the Instruments tab's imagery button does.

**The Map panel lists every layer the globe can draw, in groups, one open at a time.**
Under the overlays, "Satellite imagery" holds two groups: GEO satellites and LEO
satellites. Until the user opens or closes one, the open group is the first with a layer
on, so a layer shown from the Imagery tab or a link can be taken off where it is listed. A
group's row says how many of its layers are on.

- The group is the satellite's orbit class (`imageryLayers` in
  `src/config/instrumentImagery.ts`): GEO, and LEO for the rest, as no MEO or HEO satellite
  has a layer. It replaced groups by the entry's period, weather satellites (a frame every
  few minutes) and polar orbiters (daily), which a polar orbiter with frames by the minute
  would have put among the weather satellites; the orbit is what the panel's reader knows.
- A layer that stopped is not listed: the satellite's Imagery tab has it, and the map is
  for what is imaged now. One on the globe from a link is listed above the groups, so it
  can still be taken off.
- An entry with a viewer link alone is not listed: the satellite's Imagery tab has it, and
  a third group of links was a second place for it in a panel of what the map draws.
- A row names the satellite, its instrument and the picture, short: "PACE OCI True",
  "METEOSAT-12 FCI GeoColour" (`shortImageryLabel`). The instrument tells two layers of one
  satellite apart; the picture drops "colour" and any qualifier ("one swath per orbit",
  "Europe"), which the row's tooltip keeps. The Map panel is 300px wide for it, where 260px
  cut METEOSAT-10 to four letters. A name that leaves the rest no room, and every name on a
  phone, has the instrument and picture under it.
- A row's image button selects the satellite, turning it on if need be, at its Imagery tab,
  as the catalog's imagery mark does. It sits inside the row's label, where a press on it
  toggles nothing.
- A composite (ADR 0019) is one row, first in its first satellite's group, not a row per
  satellite all on or off together. It is named by its label's qualifier, "Geostationary
  Ring", and shows its cadence where a satellite's row shows the instrument:
  "Geostationary Ring hourly Day/Night", "Geostationary Ring 3-hourly Natural", on two
  lines. Its tooltip names its satellites, and its frames start with its earliest
  satellite's. Its image button opens a menu of its satellites, each opening that
  satellite's Imagery tab.
- The list is read off the records, so opening the Map panel loads every group, as opening
  the catalog sheet does. A layer on the globe whose record has not loaded yet is listed
  above the groups, so it can still be taken off.

**Imagery is never "on the globe" in a label.** That names the satellites shown, in the
list's footer and its filter chip; imagery is a map layer.

## Consequences

- Opening the Map panel costs what the catalog sheet costs, about 13.5 MB of JSON before
  compression, once a session.
- A tree's parent count is no longer the sum of its leaves where a satellite has several.
  The orbit and constellation trees give a satellite one leaf, so theirs are unchanged.
- The native app has this Map section, the same groups and rows read from its own
  records (`imageryListings` in `SatelliteDetails.swift`), but not the catalog sheet's
  bands chart, Data availability facet or imagery column.

## Alternatives rejected

- **Imagery as a filter inside the bands chart.** Tried as a segmented control in its
  heading, as clickable legend entries, as one switch and as worded segments with counts. In
  every form one chart filtered two things, which read as confusing. Shading each bar by its
  share with imagery stayed confusing too, and it darkened the satellites without imagery;
  the Data availability facet filters it, and the chart redraws for what it picks.
- **"All | imagery | on globe" segments.** The second contains the third, and "on the
  globe" already means the satellites shown.
- **A band to instrument tree**, as one of the trees. It counted instrument-band pairs, and
  the instruments' names say little to someone looking for a kind of picture.
- **The Map panel's layers as a build-time list** read from the imagery manifest by
  `vite.config.ts`. It would list them without loading the catalog, but it is a second route
  for per-satellite metadata beside the records, and would miss the imagery that private
  plugins add.
- **A flat list, a list folded to the layers that are on, summary chips, a list by
  satellite, or a page of its own inside the panel.** The flat list grows with the
  manifest; the others hid what is there, or took a step to reach it.
