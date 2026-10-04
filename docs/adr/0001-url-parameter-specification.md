---
status: accepted
---

# URL parameter specification

The query string is a public contract: links are shared, bookmarked, and embedded in
third-party iframes (`embedded.html`) whose URLs we cannot audit. It had never been
written down, so its conventions had drifted into fourteen hand-written
serialize/deserialize closures with two different space escapes, two boolean
implementations (one wrong), and a declared `default` field that nothing read. This
ADR is the specification.

The contract is **read-compatible**, not byte-frozen: every URL that works today keeps
working, but emitted output is allowed to differ where the old form bought nothing. The
one place that applies is space escaping — see [String lists](#string-lists).

The implementation is `src/modules/util/urlCodec.ts` (the pure part) behind
`src/modules/util/urlSync.ts` (the adapter), with the per-parameter schema declared in the
`urlsync` blocks of `src/stores/*.ts`. Invariants belong to the store actions the adapter
writes through, and `src/modules/sceneSync.ts` carries state on to the globe.

One rule is worth stating here because it is not obvious from the parameter table: while
the clock is pinned it rewrites `time` every minute, so **a change that moves only `time`
replaces rather than pushes**. The trade is that pinning by scrubbing is not separately
undoable, which is better than a history made of clock ticks.

## Parameters

Every parameter is optional. An absent parameter means "use the default" (see
[Defaults](#defaults)).

| Parameter    | State                    | Kind                | Wire form / accepted values                                                                                                              | Global default  |
| ------------ | ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `elements`   | `sat.enabledComponents`  | string list         | comma-joined component names: `Point`, `Label`, `Orbit`, `Orbit track`, `Ground track`, `Sensor cone`, `3D model`, `Ground station link` | `Point,Label`   |
| `tags`       | `sat.enabledTags`        | string list         | comma-joined tag names                                                                                                                   | empty           |
| `sats`       | `sat.enabledSatellites`  | string list         | comma-joined satellite names                                                                                                             | empty           |
| `xsats`      | `sat.disabledSatellites` | string list         | comma-joined satellite names opted out of tag activation                                                                                 | empty           |
| `gs`         | `sat.groundStations`     | ground-station list | `_`-joined; each station `lat,lon` or `lat,lon,name`; lat/lon emitted at 4 decimal places                                                | empty           |
| `track`      | `sat.trackedSatellite`   | string              | one satellite name; empty means nothing tracked                                                                                          | empty           |
| `overpass`   | `sat.overpassMode`       | enum                | `elevation` \| `swath`                                                                                                                   | `elevation`     |
| `layers`     | `cesium.layers`          | layer list          | comma-joined; each item `Name` or `Name_<alpha>`; list order is z-order                                                                  | `NaturalEarth`  |
| `terrain`    | `cesium.terrainProvider` | enum                | `None` \| `CesiumWorldTerrain` \| `ReEarth` \| `Maptiler`                                                                                | `None`          |
| `surface`    | `cesium.surfaceModel`    | enum                | `None` \| `OsmBuildings` \| `GooglePhotorealistic`                                                                                       | `None`          |
| `stars`      | `cesium.starMap`         | enum                | `Tycho1K` \| `DeepStar1K` \| `DeepStar2K`[^2]                                                                                            | `Tycho1K`       |
| `scene`      | `cesium.sceneMode`       | enum                | `3D` \| `2D` \| `Columbus` \| `Sky`                                                                                                      | `3D`            |
| `camera`     | `cesium.cameraMode`      | enum                | `Fixed` \| `Inertial`                                                                                                                    | `Fixed`         |
| `pixelratio` | `cesium.pixelRatio`      | enum                | `1` \| `1.5` \| `native`                                                                                                                 | `native`        |
| `msaa`       | `cesium.msaa`            | enum                | `off` \| `2` \| `4`                                                                                                                      | per display[^1] |
| `fps`        | `cesium.showFps`         | boolean             | `true` \| `false`                                                                                                                        | `false`         |
| `bench`      | `cesium.showBenchmark`   | boolean             | `true` \| `false`                                                                                                                        | `false`         |
| `bg`         | `cesium.background`      | boolean             | `true` \| `false`                                                                                                                        | `true`          |
| `time`       | clock time               | timestamp           | emitted as ISO-8601 at minute precision (`2026-07-26T20:46Z`); any `dayjs`-parseable value accepted                                      | absent (live)   |

[^1]:
    `msaa` is the one parameter whose default depends on the machine rather than on
    the route: `off` at a device pixel ratio of 2 or more, `2` below it
    (`defaultMsaaRate`). It is the same rule as every other default — the baseline is
    whatever the store holds after hydration — but it is worth naming, because it means
    a link with no `msaa` can render differently on a laptop and a desktop. That is the
    intent: the parameter is absent because nobody chose, and what nobody chose should
    suit the display. A link that must pin the rate says so explicitly.

[^2]:
    The two `DeepStar` cuts are optional assets, built together by
    `pnpm update-starmap`, so a deployment may have neither. They stay in the
    accepted vocabulary regardless, for the same reason `?pixelratio=1.5` is accepted on
    a display that cannot benefit from it: the parameter says what was asked for, not
    what this machine can serve. The Map menu offers the maps it can find — erring
    toward offering, since a probe that goes unanswered is treated as a yes rather than
    read as absence, which is the right guess for a PWA whose faces may be in the
    runtime cache while the network is not there. A link naming one that turns out to be
    missing falls back to `Tycho1K` with the url rewritten to match, so the radio, the
    address bar and the sky agree.

`scene=Sky` is the odd one out: the other three name a Cesium `SceneMode` and it does
not — it is the ground-level sky view, which renders in 3D. It shares the parameter
because a projection and a vantage point cannot be chosen independently, so one closed
enum cannot express the illegal combinations two parameters would have allowed. See
`docs/adr/0003-sky-view.md`.

### String lists

There is **one** string-list kind and it takes no options: join and split on `,`. Spaces
need no escaping — `URLSearchParams` and vue-router's query parser both encode a space as
`+` and decode it back identically, so spaces already round-trip losslessly.

The two historic escapes (space → `-` for `elements`/`tags`, space → `~` for
`sats`/`xsats`) were pure decoration. They bought URL cosmetics and cost two naming
constraints, so they are dropped from emission and survive only as read shims:

| Parameter        | Legacy read shim                                                        | Why                                                              |
| ---------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `elements`       | try the literal; if it is not a known component, retry with `-` → space | deterministic — components are a closed, compile-time vocabulary |
| `sats` / `xsats` | `~` → space, unconditionally                                            | open vocabulary; nothing to resolve an ambiguity against         |
| `tags`           | none                                                                    | no `tags` URL has ever carried an escape                         |

The `tags` row holds because no tag name contains a space, so the escape never fired.
Tags reach the catalog only through `SatelliteCatalog.registerGroups`, whose sole
production caller is `SatelliteManager.loadElementSets(preset.elements)`, and every tag in
the worker config (`worker/src/config/satvis.core.yaml`) is a single word. Adding a tag with a space is fine — it will
encode as `+` — but it must never be escaped as `-`.

`layers` items are validated against the leading segment before `_`. Base layers:
`NaturalEarth`, `ArcGis`, `VersaTiles`, `OSM`, `BlackMarble`. Overlays: `Tiles`,
`GOES-IR`, `Nextrad`. The split is also how the Map menu presents them — one basemap on
radios, any number of overlays on checkboxes — and `base` on the registry entry is the one
place it is decided. The optional `_<alpha>` suffix sets that layer's opacity and has no
UI control. The accepted set is derived from the imagery-provider registry
(`imageryProviderNames`), not restated, so it cannot drift.

Retiring a provider is the one way this contract is not read-compatible: `?layers=Topo`
worked until the MapTiler-keyed `Topo` basemap was removed, and now names an unknown member
of a closed vocabulary, so it is dropped and the basemap falls back to the default. That is
the documented rule doing its job rather than an exception to it — but it does mean a link
older than the registry can open on a different map, which is the price of retiring one.

`Offline` and `OfflineHighres` were retired together the same way, when the two collapsed into
the single `NaturalEarth` layer. Both old names now resolve to the default — which _is_ that
layer — so unlike `Topo` those links land on the map they always meant, and only an explicit
`?layers=Offline` asking for the deliberately-blurry one loses anything.

At most one base layer may be active. When a URL supplies several, the **last in list
order wins** and earlier base layers are dropped; all overlays are preserved regardless.
Last-wins matches what toggling a base layer means to a user. The rule belongs to the
store's `setLayers` action rather than to this codec, because it constrains the list as a
whole and has to hold whatever the source.

Note `ArcGis` (imagery) and `ArcGIS` (terrain) differ only in capitalisation and are
different things. The terrain provider is registered `visible: false`, so `?terrain=ArcGIS`
is not accepted. Do not "correct" either spelling.

`surface` is carried even when the model it names cannot apply in the current `scene` —
`GooglePhotorealistic` is the sky view only, and neither model applies in 2D or Columbus.
That is deliberate rather than an oversight in validation: the selection is suppressed, not
invalid, so `?surface=GooglePhotorealistic&scene=Sky` works and a model can be armed before
entering the view that uses it. `terrain` is likewise still emitted while a surface model
overrides it, because it says what the user chose and what returns on deselection. See
`docs/adr/0005-surface-models.md`.

`catalogRevision` and `pickMode` are store state that is deliberately **not** synced —
the former is a cache-invalidation counter, the latter a transient UI mode.

## Semantics

### Defaults

A preset supplies defaults, not initial state. The baseline for each parameter is the
preset-merged store value for the current route, so the same query string means
different things on different routes — on `/ot` the OT tag is the default and so is
absent from the URL. A parameter is emitted only when its value differs from that
baseline. Deviating from a preset therefore always produces a parameter, so no value is
unpersistable.

Defaults are computed at runtime from preset-merged state. The schema does not declare
them.

### Reading

An absent parameter resets its state to the default. Nothing invalid is ever stored, so
the store, the URL and the rendered scene cannot disagree. What "invalid" costs depends on
how it fails:

- **Malformed parameter** — the whole parameter is rejected, the state keeps its default,
  and the parameter is dropped from the URL. If the shape is wrong, none of it is
  trustworthy.
- **Unknown member of a closed vocabulary** (`elements`, `layers`, and the enums) — the
  offending element is dropped and the rest of the list is kept. A link written against a
  different build referencing a component that no longer exists should not wipe the whole
  selection. For a scalar enum there is no "rest", so this collapses to the malformed case.
  For `elements` the legacy shim runs **before** this rule: an element is dropped only if
  neither the literal form nor the `-` → space form names a known component. There is one
  limit on the rule: if the value names members and **none** of them survives, there is no
  rest to keep, so the whole parameter is rejected and the default stands. A misspelling
  like `?layers=Bogus` used to open a globe with no imagery on it at all. A literally empty
  `?layers=` or `?elements=` names no member and still means none.
- **Malformed element of `gs`** — that station is dropped, the remaining stations are
  kept.
- **Open vocabularies** (`tags`, `sats`, `xsats`, `track`) — **not membership-validated at
  all**, only format-validated. Group data loads lazily, so at parse time the catalog
  usually cannot say whether a name exists. Unknown names are retained and resolve if and
  when their group loads; this is already how `pendingTrackedSatellite` and
  `#ensureCatalogCoverage` are designed to behave.

`bg=false` is the one place the agreement is deliberately not enforced. It takes the
whole background away — sky box, sun, moon, atmosphere — so `stars` no longer describes
anything on screen, and `applyStarMap` returns without installing a sky box rather than
putting stars behind a scene that asked to be transparent. The store and the URL keep
saying which map was chosen, because that is still the answer to "what should be behind
the globe" and it is what a link with `bg` removed would render. Nothing is drawn from
it while the background is off.

### Writing

The whole query string is rebuilt from state on every change. Parameters not listed
above are preserved verbatim — this is not the codec's namespace.

A write that produces an identical query string is skipped entirely.

History entries represent user intent. User-initiated changes use `pushState`, so the
back button undoes them. Clock-driven changes to `time` use `replaceState`, because a
minute elapsing is not an intent; those writes are additionally throttled so a high
`clock.multiplier` cannot flood the history API. All history writes go through
vue-router so that `currentRoute` never goes stale, and back/forward re-apply state from
the query.

### Time

The clock is **live** by default and `time` is absent. It becomes **pinned** only by a
deliberate act: a `time` parameter in the incoming URL, or the user scrubbing the
timeline (Cesium's `Timeline` `settime` event). While pinned, `time` follows the clock at
minute granularity so a shared link reproduces the moment the sharer was looking at. A
link without `time` opens at the recipient's present, which is the behaviour that
predates this ADR.

## Naming constraints

The delimiters are in-band and cannot be escaped: `URLSearchParams` percent-decodes a
value before we split it, so `%2C` and a literal `,` are indistinguishable, and `~` is an
unreserved character for which `%7E` and `~` decode identically. Escaping is therefore
impossible without hand-rolling the query parse.

Instead, the affected vocabularies are constrained, and **the codec validates on
serialize as well as on parse** — an unrepresentable value is refused at the boundary
rather than silently corrupted.

There is one real rule — **no comma in a list member** — plus one carve-out per parameter
that owns a second delimiter:

| Vocabulary           | Constraint     | Source of the carve-out        |
| -------------------- | -------------- | ------------------------------ |
| tag names            | no `,`         | —                              |
| component names      | no `,`         | —                              |
| satellite names      | no `,`, no `~` | the `sats`/`xsats` legacy shim |
| ground-station names | no `,`, no `_` | the `gs` station separator     |
| imagery layer names  | no `,`, no `_` | the `layers` alpha suffix      |

No existing name violates these. Component and layer names are closed, compile-time
vocabularies, so those rows hold by construction. The satellite-name row is inherited from
`sats`/`xsats`; `track` is a bare string with no delimiter and could carry a comma on its
own, but the same name must be representable everywhere it appears.

Hyphens are legal everywhere. The `~` carve-out exists only to keep the legacy shim
unambiguous and would disappear if `sats`/`xsats`/`track` ever stopped carrying names.

Keying those three on NORAD ids was considered for exactly that reason and **deferred**.
It is not a wire-format change: a NORAD id is not an identity in the current catalog
model, where the dedup key is `satnum|name`, names are unique (`#byName`, first-wins) and
satnums are modelled one-to-many because renames can fork one object into several entries.
Adopting ids means first deciding whether a rename replaces or forks, which is a catalog
decision with its own migration. Nothing in this specification forecloses it: an id form
would arrive as another read shim alongside the ones above.

Ground-station coordinates are stored at 4 decimal places (~11 m). This is a deliberate
size/precision trade, not a defect.

## Considered options

**Keeping the two space escapes** and freezing emission byte-for-byte was the first
position. Rejected once it became clear the escapes are decoration: both readers already
round-trip spaces through `+`, so the escapes bought nothing and cost a hyphen ban on
tags and components. Dropping them from emission costs a legacy read shim per parameter
and breaks no existing link.

**A raw-first reader** that splits the un-decoded query before percent-decoding each
element would make `,` escapable inside satellite and station names. Rejected: it means
hand-rolling `+` → space and percent-decoding, and every trap it closes is latent rather
than reachable — there is no ground-station name input in the UI today, and CelesTrak
`OBJECT_NAME` values contain no commas. Validating on serialize gets the safety without
the parser.

## Consequences

`?fps=false` changed meaning. It used to deserialize to the truthy string `"false"` and
switch the counter **on**; the boolean kind makes the link do what it says. This is the
one place an existing link changes behaviour rather than merely continuing to work.

`?terrain=Garbage` and its siblings stopped diverging. The store used to accept the
value, Cesium logged `Unknown terrain provider` and no-opped, and the store, URL and radio
buttons all reported a terrain that was never applied. Validation now rejects it on the
way in.

Ground stations are no longer stored as `NaN`; malformed ones are dropped at parse time.
That retired `CesiumController.setGroundStations` and its `gs.lat && gs.lon` filter, which
discarded any station on the equator or the Greenwich meridian because `0` is falsy —
`?gs=0,11.5` used to round trip to an empty store and now renders.

Emitted URLs change shape for `elements`, `sats` and `xsats`: `Sensor-cone` becomes
`Sensor+cone`, `NOAA~19` becomes `NOAA+19`. Existing links keep working through the read
shims, so the two forms coexist in the wild indefinitely. Both must stay covered by
tests — the legacy form has no other way to be exercised once nothing emits it.

Adding a component or tag whose name contains a hyphen is now an ordinary change. For
components it also exercises the `elements` shim's membership resolution, so a name that
collides with an escaped form of another component — a literal `Sensor-cone` alongside
`Sensor cone` — would be ambiguous. That is worth an assertion over the component list
rather than a constraint.
