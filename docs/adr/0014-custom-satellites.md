---
status: accepted
---

# Custom satellites are pasted element sets, kept per browser

The catalog holds what the groups serve. A satellite they do not carry, one launched this
week, a planned orbit, or a satellite with elements of one's own, could not be added short
of the console.

## Decision

**An "Add custom" button in the catalog sheet's header opens a dialog.** It takes pasted text
or a file: a TLE with or without its name line, or an OMM as JSON (CelesTrak's, Space-Track's),
CSV with a header row, XML or KVN. Every OMM format becomes the JSON the groups serve, so a
custom record is one `parseGpPayload` already reads (`src/modules/customSatellites.ts`).

- Each element set is checked before it is offered: an OMM must carry the fields SGP4 starts
  from, and the elements must propagate at their epoch. The drag terms default to zero. The
  dialog lists what it dropped and why.
- Adding puts the satellites under the `Custom` tag and onto the globe by name, through
  `setActivation` as every writer does, at most `SHOW_CAP` of them. One added alone opens its
  info panel.

**Kept in `localStorage`, like bookmarks (ADR 0011), not in the url.** A link carries a custom
satellite's name in `sats=`, as it carries any satellite's, but not its elements: they would
make every link and bookmark long, and the native app's url codec would need them too. A link
to one opens without it in another browser. The stored satellites enter the catalog before the
route's groups load, so their names in `sats=` do not make the app load every group to look for
them.

**A name of its own; a NORAD id that may be shared.** Activation goes by name, so a custom
satellite may not take a catalog satellite's name; one of an existing custom satellite's name
replaces it. Its NORAD id may be a catalog satellite's, under other elements, so:

- The catalog sheet lists it in a row of its own, where other rows are one per NORAD id.
- The propagation workers cache one satrec per key, so a custom satellite gets a key of its
  own (`custom-<n>`), new for each element set, rather than its NORAD id. A replaced satellite
  is disposed and built again with its new elements, and tracked again if it was.

## Consequences

- The native app has no custom satellites. A link naming one opens without it there.
- Pasting a whole catalog works, but every name lands in the browser's storage, and only the
  first `SHOW_CAP` on the globe.
- A custom satellite's catalog key has a prefix of its own (`custom|`), so a group that
  serves its name and NORAD id later, a new launch catalogued after it was pasted, adds an
  entry beside it rather than its tag to it. Removing the custom satellite leaves the group's.
- The name check sees only the groups loaded, those of the route's preset. A custom satellite
  whose name a group of another route, or a later one, also serves is drawn beside that
  satellite, and takes its name for selection and tracking until it is renamed or removed.

## Alternatives rejected

- **Elements in the url.** Links would carry them anywhere, but a TLE is 140 characters, a
  bookmark copies every one, and ADR 0001 and the native codec would need another list.
- **A custom satellite under its NORAD id's row and satrec.** The workers would propagate
  whichever element set reached them first, and the catalog would hide one of the two.
