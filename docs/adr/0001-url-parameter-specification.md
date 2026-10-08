---
status: accepted
---

# URL parameter specification

The query string is a public contract. Links are shared, bookmarked, and embedded
in third-party iframes (`embedded.html`) whose URLs we cannot audit. Before this ADR
it was not written down, and it had drifted into fourteen hand-written
serialize/deserialize closures with two space escapes, two boolean implementations
(one wrong), and a `default` field that nothing read. This ADR is the specification.

The contract is **read-compatible**, not byte-frozen: every URL that works today
keeps working, but emitted output may differ where the old form bought nothing. That
applies only to space escaping (see [String lists](#string-lists)).

The pure codec is `src/modules/util/urlCodec.ts`, behind the adapter
`src/modules/util/urlSync.ts`. Each store declares its parameters in its `urlsync`
block (`src/stores/*.ts`). Invariants belong to the store actions the adapter writes
through. `src/modules/sceneSync.ts` carries state on to the globe.

## Parameters

Every parameter is optional. An absent parameter means "use the default" (see
[Defaults](#defaults)).

| Parameter    | State                    | Kind                | Wire form / accepted values                                                                                                              | Global default    |
| ------------ | ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `elements`   | `sat.enabledComponents`  | string list         | comma-joined component names: `Point`, `Label`, `Orbit`, `Orbit track`, `Ground track`, `Sensor cone`, `3D model`, `Ground station link` | `Point,Label`[^3] |
| `tags`       | `sat.enabledTags`        | string list         | comma-joined tag names                                                                                                                   | empty             |
| `sats`       | `sat.enabledSatellites`  | string list         | comma-joined satellite names                                                                                                             | empty             |
| `xsats`      | `sat.disabledSatellites` | string list         | comma-joined satellite names opted out of tag activation                                                                                 | empty             |
| `gs`         | `sat.groundStations`     | ground-station list | `_`-joined; each station `lat,lon` or `lat,lon,name`; lat/lon emitted at 4 decimal places                                                | empty             |
| `track`      | `sat.trackedSatellite`   | string              | one satellite name; empty means nothing tracked                                                                                          | empty             |
| `overpass`   | `sat.overpassMode`       | enum                | `elevation` \| `swath`                                                                                                                   | `elevation`       |
| `layers`     | `cesium.layers`          | layer list          | comma-joined; each item `Name` or `Name_<alpha>`; list order is z-order                                                                  | `NaturalEarth`    |
| `terrain`    | `cesium.terrainProvider` | enum                | `None` \| `CesiumWorldTerrain` \| `ReEarth` \| `Maptiler`                                                                                | `None`            |
| `surface`    | `cesium.surfaceModel`    | enum                | `None` \| `OsmBuildings` \| `GooglePhotorealistic`                                                                                       | `None`            |
| `stars`      | `cesium.starMap`         | enum                | `Tycho1K` \| `DeepStar1K` \| `DeepStar2K`[^2]                                                                                            | `Tycho1K`         |
| `scene`      | `cesium.sceneMode`       | enum                | `3D` \| `2D` \| `Columbus` \| `Sky`                                                                                                      | `3D`              |
| `unseen`     | `cesium.unseen`          | enum                | `show` \| `dim` \| `hide`: in the sky view, how the satellites that cannot be seen are drawn                                             | `dim`             |
| `camera`     | `cesium.cameraMode`      | enum                | `Fixed` \| `Inertial`                                                                                                                    | `Fixed`           |
| `pixelratio` | `cesium.pixelRatio`      | enum                | `1` \| `1.5` \| `native`                                                                                                                 | `native`          |
| `msaa`       | `cesium.msaa`            | enum                | `off` \| `2` \| `4`                                                                                                                      | per display[^1]   |
| `fps`        | `cesium.showFps`         | boolean             | `true` \| `false`                                                                                                                        | `false`           |
| `bench`      | `cesium.showBenchmark`   | boolean             | `true` \| `false`                                                                                                                        | `false`           |
| `bg`         | `cesium.background`      | boolean             | `true` \| `false`                                                                                                                        | `true`            |
| `time`       | clock time               | timestamp           | emitted as ISO-8601 at minute precision (`2026-07-26T20:46Z`); any `dayjs`-parseable value accepted                                      | absent (live)     |

[^1]:
    `msaa` is the one default that depends on the machine, not the route: `off` at a
    device pixel ratio of 2 or more, `2` below it (`defaultMsaaRate`). The rule is
    the same as for every other default (the baseline is the store after hydration),
    so a link with no `msaa` can render differently on two displays. That is the
    intent: nobody chose, so the display decides. A link that must pin the rate
    states it.

[^2]:
    The two `DeepStar` cuts are optional assets, built by `pnpm update-starmap`, so a
    deployment may have neither. They stay in the accepted vocabulary anyway, as
    `?pixelratio=1.5` is accepted on a display that cannot use it: the parameter
    says what was asked for, not what this machine can serve. The Map menu offers the
    maps it can find, and treats an unanswered probe as present, which suits a PWA
    whose faces may be cached while the network is down. A link naming a missing map
    falls back to `Tycho1K` and the url is rewritten to match.

[^3]:
    Above a component's budget the default loses it: `Label` past 200 active
    satellites, `3D model` past 200 that have a model, `Ground station link` past 500
    (`COMPONENT_BUDGETS` in
    `src/modules/sceneSync.ts`). Crossing a budget switches the component off in the
    store, and the baseline follows, so a bare `?tags=Starlink` stays bare. Above the
    budget `elements=Point,Label` is not the default, so it is emitted, and a link
    that names a component keeps it through the crossing its own activation causes.
    Hydration drops `elements=Point,Label` as a default before the catalog can count,
    so `arrivalParam` in `urlSync.ts` keeps the link as it arrived until the first
    push.

`scene=Sky` is not a Cesium `SceneMode`. It is the ground-level sky view, which
renders in 3D. It shares the parameter because a projection and a vantage point
cannot be chosen independently, and one closed enum cannot express the illegal
combinations two parameters would allow. See ADR 0003.

### String lists

There is **one** string-list kind, with no options: join and split on `,`. Spaces
need no escaping. `URLSearchParams` and vue-router's query parser both encode a
space as `+` and decode it back, so spaces round-trip.

The two old escapes (space → `-` for `elements`/`tags`, space → `~` for
`sats`/`xsats`) bought only URL cosmetics and cost two naming constraints. They are
not emitted. They survive as read shims:

| Parameter        | Legacy read shim                                                        | Why                                                              |
| ---------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `elements`       | try the literal; if it is not a known component, retry with `-` → space | deterministic — components are a closed, compile-time vocabulary |
| `sats` / `xsats` | `~` → space, unconditionally                                            | open vocabulary; nothing to resolve an ambiguity against         |
| `tags`           | none                                                                    | no `tags` URL has ever carried an escape                         |

The `tags` row holds because no tag name contains a space. Tags reach the catalog
only through `SatelliteCatalog.registerGroups`, whose only production caller is
`SatelliteManager.loadElementSets(preset.elements)`, and every tag in
`worker/src/config/satvis.core.yaml` is one word. A tag with a space is allowed; it
encodes as `+`, and must never be escaped as `-`.

`layers` items are validated against the segment before `_`. Base layers:
`NaturalEarth`, `ArcGis`, `VersaTiles`, `OSM`, `BlackMarble`, `VIIRS`. Overlays: `Tiles`,
`GOES-IR`, `Nextrad`. `VIIRS` and `GOES-IR` show the frame for `time` (`GibsTimeLayer`).
The Map menu shows one basemap on radios and any number of overlays on checkboxes;
`base` on the registry entry (`src/modules/CesiumLayerProviders.ts`) decides which is
which. The optional `_<alpha>` suffix sets the layer's opacity and has no UI control.
The accepted set comes from the registry (`imageryProviderNames`), so it cannot drift.

Retiring a provider is the one way this contract is not read-compatible. `?layers=Topo`
names a removed member of a closed vocabulary, so it is dropped and the basemap falls
back to the default. A link older than the registry can therefore open on a
different map. `Offline` and `OfflineHighres` were retired when they merged into
`NaturalEarth`; both resolve to the default, which is that layer, so those links
land on the map they meant.

At most one base layer is active. When a URL supplies several, the **last in list
order wins** and earlier base layers are dropped; all overlays are kept. Last-wins
matches what toggling a base layer means to a user. The rule lives in the store's
`setLayers` action, not in the codec, because it constrains the whole list whatever
the source.

`ArcGis` (imagery) and `ArcGIS` (terrain) are different things. The terrain provider
is registered `visible: false`, so `?terrain=ArcGIS` is not accepted. Do not
"correct" either spelling.

`surface` is carried even when its model cannot apply in the current `scene`
(`GooglePhotorealistic` is sky view only, and neither model applies in 2D or
Columbus). The selection is suppressed, not invalid, so
`?surface=GooglePhotorealistic&scene=Sky` works and a model can be armed before
entering its view. `terrain` is likewise emitted while a surface model overrides it,
because it is what the user chose and what returns on deselection. See ADR 0005.

`catalogRevision` (a cache-invalidation counter) and `pickMode` (a transient UI
mode) are store state that is deliberately **not** synced.

### Read once, outside the store

`framems` changes how the app is driven, not what it shows, so it is not store
state. It is read once at startup from the query string, and the writer preserves it
like any other unlisted parameter.

| Parameter | Wire form / accepted values                                                         | Default      |
| --------- | ----------------------------------------------------------------------------------- | ------------ |
| `framems` | milliseconds between frames; bare or not a positive number is `16`; `0`/`false` off | absent (off) |

It supplies frames to a page that gets none from the browser, such as a hidden,
automated browser pane. See `src/modules/benchmark/README.md`.

## Semantics

### Defaults

A preset supplies defaults, not initial state. The baseline for each parameter is the
preset-merged store value for the current route, so one query string can mean
different things on different routes: on `/ot` the OT tag is the default and is
absent from the URL. A parameter is emitted only when its value differs from the
baseline, so any deviation from a preset produces a parameter and every value can be
persisted.

Defaults are computed at runtime from preset-merged state. The schema does not
declare them.

### Reading

An absent parameter resets its state to the default. Nothing invalid is stored, so
the store, the URL and the scene cannot disagree. Invalid input is handled by kind:

- **Malformed parameter:** the whole parameter is rejected, the state keeps its
  default, and the parameter is dropped from the URL.
- **Unknown member of a closed vocabulary** (`elements`, `layers`, the enums): that
  element is dropped and the rest of the list is kept, so a link from another build
  does not lose its whole selection. A scalar enum has no rest, so this is the
  malformed case. For `elements` the legacy shim runs **first**: an element is
  dropped only if neither its literal nor its `-` → space form is a known component.
  If the value names members and **none** survives, the whole parameter is rejected
  and the default stands (so `?layers=Bogus` does not open a globe with no imagery).
  A literally empty `?layers=` or `?elements=` still means none.
- **Malformed `gs` element:** that station is dropped and the rest are kept.
- **Open vocabularies** (`tags`, `sats`, `xsats`, `track`): format-validated only,
  **not membership-validated**. Group data loads lazily, so at parse time the
  catalog usually cannot say whether a name exists. Unknown names are kept and
  resolve when their group loads, as `pendingTrackedSatellite` and
  `#ensureCatalogCoverage` expect.

`bg=false` is the one place where the agreement is deliberately not enforced. It
removes the whole background (sky box, sun, moon, atmosphere), so `stars` describes
nothing on screen, and `applyStarMap` installs no sky box. The store and the URL
still record the chosen map, because that is what a link with `bg` removed would
render.

### Writing

The whole query string is rebuilt from state on every change. Parameters not listed
above are preserved verbatim. A write that produces an identical query string is
skipped.

History entries represent user intent. User changes use `pushState`, so the back
button undoes them. Clock-driven changes to `time` use `replaceState`, and are
throttled so a high `clock.multiplier` cannot flood the history API. While the clock
is pinned it rewrites `time` every minute, so **any change that moves only `time`
replaces instead of pushing**. The cost is that pinning by scrubbing is not
separately undoable, which is better than a history of clock ticks. All history
writes go through vue-router so `currentRoute` stays current, and back/forward
re-apply state from the query.

### Time

The clock is **live** by default and `time` is absent. It is **pinned** whenever it
is more than a minute off the present, the url's own granularity, however it got
there: a `time` parameter in the incoming URL, a scrub on the clock deck's timeline,
a pass link, a pause, or a fast playback speed. Back within the minute it is live
again and `time` goes, so an absent `time` and the deck's Live dot always agree
(`offPresent` in `src/modules/util/clockDeck.ts`). While pinned, `time` follows the
clock at minute granularity, so a shared link reproduces the moment the sharer saw.
A link without `time` opens at the recipient's present, and arriving at a url without
it while the clock is pinned (Back, a bookmark) takes the clock live, at real time, as
the deck's "Back to now" does (`startSceneSync`).

Pinning only on a deliberate act, the earlier rule, left the url saying "live" while
the clock showed another moment: after a pass link, or at 600× after "Back to now",
a shared link opened at the present instead of what the sharer saw.

## Naming constraints

The delimiters are in-band and cannot be escaped. `URLSearchParams` percent-decodes a
value before we split it, so `%2C` and `,` are the same, and `~` is unreserved, so
`%7E` and `~` decode the same. Escaping would need a hand-rolled query parser.

Instead the affected vocabularies are constrained, and **the codec validates on
serialize as well as on parse**: an unrepresentable value is refused at the boundary
instead of being corrupted.

The rule is **no comma in a list member**, plus one carve-out per parameter that
owns a second delimiter:

| Vocabulary           | Constraint     | Source of the carve-out        |
| -------------------- | -------------- | ------------------------------ |
| tag names            | no `,`         | —                              |
| component names      | no `,`         | —                              |
| satellite names      | no `,`, no `~` | the `sats`/`xsats` legacy shim |
| ground-station names | no `,`, no `_` | the `gs` station separator     |
| imagery layer names  | no `,`, no `_` | the `layers` alpha suffix      |

No existing name violates these. Component and layer names are closed, compile-time
vocabularies, so those rows hold by construction. `track` has no delimiter of its
own, but it carries the same satellite names as `sats`/`xsats`, which must be
representable everywhere.

Hyphens are legal everywhere. The `~` carve-out exists only to keep the legacy shim
unambiguous, and would go if `sats`/`xsats`/`track` stopped carrying names.

Keying those three on NORAD ids was considered and **deferred**. A NORAD id is not an
identity in the current catalog model: the dedup key is `satnum|name`, names are
unique (`#byName`, first wins), and satnums are one-to-many because a rename can fork
one object into several entries. Adopting ids first needs a catalog decision on
whether a rename replaces or forks, with its own migration. This specification does
not block it: an id form would arrive as another read shim.

Ground-station coordinates are stored at 4 decimal places (~11 m), a deliberate
size/precision trade.

## Considered options

**Keeping the two space escapes** and freezing emission byte for byte. Rejected:
both readers already round-trip spaces through `+`, so the escapes bought nothing and
cost a hyphen ban on tags and components. Dropping them costs one legacy read shim
per parameter and breaks no link.

**A raw-first reader** that splits the un-decoded query before percent-decoding each
element, which would make `,` escapable in satellite and station names. Rejected: it
means hand-rolling `+` → space and percent-decoding, and every trap it closes is
latent. The UI has no ground-station name input, and CelesTrak `OBJECT_NAME` values
contain no commas. Validating on serialize gives the safety without the parser.

## Consequences

`?fps=false` changed meaning. It used to deserialize to the truthy string `"false"`
and switch the counter **on**; now it does what it says. This is the one place an
existing link changes behaviour.

`?terrain=Garbage` and similar no longer diverge. The store used to accept the value
while Cesium logged `Unknown terrain provider` and did nothing, so the store, URL and
radio buttons reported a terrain that was never applied. Validation now rejects it.

Malformed ground stations are dropped at parse time, not stored as `NaN`. This
retired `CesiumController.setGroundStations` and its `gs.lat && gs.lon` filter, which
dropped any station on the equator or the Greenwich meridian (`0` is falsy).
`?gs=0,11.5` now renders.

Emitted URLs change shape for `elements`, `sats` and `xsats`: `Sensor-cone` becomes
`Sensor+cone`, `NOAA~19` becomes `NOAA+19`. Old links work through the read shims, so
both forms exist in the wild indefinitely. Tests must cover both, because nothing
emits the legacy form any more.

A component or tag name with a hyphen is now an ordinary change. For components it
goes through the `elements` shim's membership resolution, so a literal `Sensor-cone`
beside `Sensor cone` would be ambiguous. Guard that with an assertion over the
component list, not a naming constraint.
