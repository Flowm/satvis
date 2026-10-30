---
status: accepted
---

# Bookmarks are links, kept per browser

A scene can take many settings to build, and as many to take apart: a shared link can
pin the clock, track a satellite, stand in the sky view, and swap the map, and getting
back to the plain globe meant undoing each in its own panel. Nor could a visitor keep
a scene to come back to, other than as a browser bookmark of its url.

## Decision

**A bookmark is a link: a route and the url parameters the stores own** (ADR 0001),
under a name, with a picture (`src/modules/util/bookmarks.ts`). Opening one is a
navigation to that link. It holds no camera position, because the url holds none:
tracking and the sky view place their own camera, and a globe opens at the default
distance. Storing the camera beside the query would make a bookmark more than a link,
which the native app's url codec could not follow.

**"Bookmark", in the code and on screen.** "View" names the view mode and the sky
view, and "preset" the route's starting configuration, so neither could name a stored
link without a qualifier.

**Three kinds.** A **featured** bookmark ships with the route's preset, live and with
a group or a single satellite rather than a list, so it shows the present and reads at
a glance. The ISS is followed alone: the rest of the Stations group crowds the
close-up. The sky shows every active satellite, as points past the label budget. The
about page shows the default preset's as a carousel, linking to them live, and About
opens them in place; the App Store screenshots are the same three, at a pinned minute.
The first is the default preset's weather globe, so it is also the default view. A
**saved** bookmark is one the visitor named. An **opened link** is a link a visit
started with, so a shared link can be found again after wandering off it. Only a
navigation counts: a reload, Back or Forward reopens the visitor's own scene, an
embedded page is someone else's, and a link already among the route's featured or
saved bookmarks is not recorded twice; saving one takes it off Recent. The newest eight are
kept, each once. Nor is a scene saved twice: while the scene on screen is saved,
"Save this view" reads "Saved" and opens that bookmark's name.

**Featured bookmarks belong to the preset, in the worker config.** Each preset lists
its own (`featured` in `worker/src/config/satvis.core.yaml` and a plugin's
`satvis.yaml`), served with the group index beside its `defaults`, and the Bookmarks
panel shows only the route's: a preset is a product's starting point (`/ot` is a
plugin's), and another preset's would open with a page load into someone else's
app. A preset with none has no Featured tab. They were called demos and shipped in the
bundle, for the default route alone; a plugin had no way to feature its own. The cost
is that they arrive with the index rather than the bundle, which the static `data/gp/`
snapshot also carries. Each is written as a link against its preset's `defaults`,
with an empty query for the default view. Making the defaults themselves a bookmark
entry, as the parameters are the same, was rejected: in one list, `tags` would have
meant "the value is" in that entry and "change it to" in the next. Every one has a
picture, a path on the site: the core's in `public/showcase/`, a plugin's shipped by
its `sync.sh` to `data/showcase/`. The generator checks the shape and each `tags`
against the preset's groups; a frontend test holds the core's queries to the url codec,
which the worker does not have. On another preset's route About leaves out the about
page's carousel, which can only show the default preset's: it is static html, for
crawlers.

**Kept in `localStorage`, per browser, never in the url or on the worker.** It is the
app's first local state. A private window or blocked site data leaves bookmarks
working for the visit; a full quota drops the pictures before the bookmarks. Nothing
syncs between devices.

**The default view is the route's preset, as it opens: no scene parameter.** Foreign
parameters such as `framems` stay. A url without `time` used to clear the store and
leave the clock where it was, which then wrote `time` back, so neither this nor Back
returned to live. `startSceneSync` now takes a clock that is off the present live
when `time` goes, as the deck's "Back to now" does (`CesiumController.goLive`). A clock
paused or fast at the present carries no `time` for its first minute, so the default
view and every bookmark without `time` also go live directly.

**A bookmark from another preset opens with a page load.** The url sync reads the
route's preset defaults once, at startup, and a query means something else under
another preset (ADR 0001, Defaults). A bookmark records its preset's path (`/`, `/ot`),
however the page was reached, so `/index.html` or a path naming no preset is the route
it opens; its card is described against that preset. Foreign parameters go along.

**A gallery of cards, from a prototype of three panels.** A sectioned list read like
settings; a panel of one chip per changed setting, each undoable alone, explained the
scene but not where to go. Cards with pictures were the quickest to tell apart. Each
card says which satellites and where the camera is, and the pinned time sits on the
picture as a badge, green "Live" when none is. Components and map layers are left out:
listed, they crowded out the two facts that tell scenes apart. The variants are on
the branch `claude/views-presets-ui-prototype-fb0086`.

**The picture is the globe's next frame**, drawn in `postRender`, where the drawing
buffer is intact without `preserveDrawingBuffer` and its per-frame copy
(`src/modules/util/thumbnail.ts`). 320 px wide, WebP, or JPEG where the browser
encodes no WebP (Safari): 4–11 kB measured. An opened link is pictured once its tiles and
satellites have loaded, and not at all if the visitor has moved on. The featured
bookmarks' cards are small copies of the showcase pictures, precached so the panel
works offline.

## Consequences

- **The native app keeps the same records**, per device (`BookmarkStorage`): its links
  decode the same query, its featured bookmarks reach it with the group index, and
  the parameters the stores own through the parity script's `web-tables.json`.
  Releases before featured bookmarks keep the three demos they bundled.
- **A featured bookmark's picture is a moment, not the present.** The sky one shows a
  night sky on its card and a daylight one at noon.
- **A bookmark's meaning can drift** with its preset's defaults, as any link's can.
