---
status: accepted
---

# The satellite catalog is a crossfilter over every satellite

The Satellites panel lists groups and finds satellites by name. Nothing gave an overview
of the catalog, ~16,800 satellites, or found them by what they are: every sun-sync
imager, the Chinese satellites launched since 2020, a constellation's newest shell. The
records already carry the facts (ADR 0002, 0006, 0008); only a way to see and filter them
was missing.

A throwaway prototype settled the design over several rounds; its variants and the verdict
are on the branch `claude/satellite-browser-variants-ee55c1`
(`src/components/prototype-satellite-browser/VERDICT.md`). It beat a faceted table, a
group-by drawer and a query line.

## Decision

**A crossfilter dashboard, opened from the Satellites panel.** A button in the panel opens
the catalog sheet, which takes the panel's place. The compact panel stays for quick group
toggles and search, so its tests and the native app's browser are untouched.

- Every chart is a filter. Each counts under every filter but its own, so a pick never
  hides its siblings. One pass computes all the counts: a satellite failing no filter
  counts everywhere, and one failing exactly one counts toward that chart alone
  (`crossfilter` in `src/modules/catalogFacets.ts`).
- Everything is computed in the browser, from the records the groups already serve. There
  is no new endpoint, and no metadata the frontend reads only here.

**One layout at two sizes.** The sheet sits over the lower globe and grows to full screen
and back. The header, the hero charts (launches per year, orbit shape), the facet tiles
and the list keep their places and only grow.

- A tile opens in place: full width, twice its height, capped at 520 px and at the column.
  The list picks its columns by its own width.
- Phones get Filters and Satellites tabs instead of two columns.

**Showing writes names, at most 500.** "Show only these", "add", "hide" and "clear globe"
write the three activation lists through `setActivation`, as every writer does.

- Hide drops a group whose every member it hides, rather than listing each member in
  `xsats=`.
- A filter can match the whole catalog, and every name lands in the url and in every
  bookmark of it, so a show takes the first 500 and the sheet says so.
- Storing the filter itself in the url is the follow-up. It needs a fourth activation list,
  its codec in ADR 0001 and in the native app, and a bookmark summary.

**The orbit tree: the derived class, then GCAT's kind.** The top level is the orbit class,
derived and always present (ADR 0002). Under it is the kind, as GCAT's `OpOrbit` names
it: a LEO's inclination band (equatorial, intermediate, polar, sun-sync, retrograde), a
GEO's station keeping, a Molniya HEO. The definitions are GCAT's own
(planet4589.org/space/gcat/web/intro/orbits.html).

- GCAT has no code for about 1,100 of today's satellites, among them every one launched
  in the last 90 days, because it lags new launches. Where it has none, or a code for a
  class the orbit has left, the kind is computed from the element set by GCAT's bounds.
- GCAT's codes that are kinds of their own (VHEO, GTO, DSO) sit under whichever class the
  orbit has. The list stars a computed kind, and says where it came from.
- These are two fields, not a fallback within one (ADR 0008): `opOrbit` is upstream, the
  computed kind is derived, and `CatalogEntry.orbitKind` alone chooses between them
  and says which it took.
- Only what the elements reproduce is computed. On today's catalog the LEO bands agree
  with GCAT's codes for 15,223 of 15,225 satellites. GCAT classes the canonical orbit,
  not the current one, so its lower/upper LEO split (91.6%) and its GEO kinds (63%) are
  not computed.
- GCAT's "sun-sync" is an inclination band, 95-104°. The info panel's SSO, a precession
  test, stays as it is: it answers a different question, whether the orbit holds its
  local time.

**Constellations from GCAT's programme.** GCAT's `Program` ("Starlink 2MO S1", "OneWeb")
is a new upstream field. Its first word names the constellation, so the facet is a tree:
Starlink holds 18 programmes. A satellite GCAT does not list yet is under "Not in GCAT
yet", not guessed from its name.

**Every other facet is labelled metadata.** Group, purpose, country, operator, owner type,
status, maker, bus, launch site and 3D model come straight from the bag. So do two
buckets: size by launch mass, and element set age from the epoch, worked out without a
satrec (`epochMsOf`).

## Consequences

- Showing a satellite's info shrinks the sheet; on a phone, where even the sheet covers most
  of the screen, it closes it. Escape goes through the app's own handler, so an open dialog or
  an input keeps it, and opening any menu panel closes the sheet.
- The icon bundle's scan reads `.ts` as well: the facets name their icons in data, and an icon
  it misses would be fetched from api.iconify.design at runtime.
- Each record grows by about 20 bytes, for `opOrbit` and `program`; KV picks them up at
  the next `push-catalog` and `push-gp`.
- Opening the sheet loads every group, about 13.5 MB of JSON before compression, the
  cost the panel's search already pays.
- The native app has no catalog sheet. Its browser is held by no parity fixture, so this
  is a gap to close, not a broken contract.
- A show of more than 200 satellites crosses sceneSync's label budget, which turns labels
  off and does not turn them back on. Any large group does the same today.

## Alternatives rejected

- **A filter in the url, now.** It is the right end state, but a fourth activation list
  touches the codec, the native app and bookmarks. That is its own decision.
- **Constellations from name prefixes.** The prototype's first-word rule needed a stop list
  (COSMOS, rocket stages, rideshares) and aliases, and still merged Galileo with India's
  GSATs. GCAT's programme is curated.
- **The info panel's SSO test as the orbit kind.** It is the physical answer, but it
  disagrees with GCAT for 216 satellites launched into sun-sync that have since sunk. In
  one tree, two definitions of "sun-sync" would contradict each other.
- **Bounds fitted to GCAT's codes.** They reached the same agreement, but GCAT publishes its
  own, and a satellite should land in the same kind whichever source classified it.
- **A large tile over the whole charts column.** It hid the charts it was filtering
  against. Opening in place keeps them beside it.
