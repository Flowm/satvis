# Domain glossary

Terms with a precise meaning in this codebase. Use these names in code and
discussion; sharpen them here when they drift.

- **Satellite**: one orbiting object, identified by a catalog entry
  (satnum + name) built from a GP element set (OMM or TLE).
- **Catalog**: the deduplicated registry of satellites across all loaded
  groups, with tag merging (`SatelliteCatalog`). Metadata is not resolved here —
  it arrives attached to the record.
- **Group**: a named, declaratively-configured list of element sets served as
  one unit (`/api/gp/<group>.json` or the static snapshot). A group decides what
  is served and under which name, never what is true of a satellite: per-satellite
  facts live in the satellite table, which is independent of any group. A
  preset may register a group as **search-only**: its satellites are in the
  catalog and can be found and enabled one by one, but its tags get no group row
  and no place in the group multiselect, because enabling it whole is not a
  choice worth offering. A group may
  also be the **remainder** of its sources after other groups are taken out
  (`exclude`), which is how one upstream list is served in disjoint pieces.
- **Satellite table**: the registry of static per-satellite facts, identified by
  NORAD id and independent of the groups that serve those satellites. One table,
  two contributors — the curated rows hand-written across every config that
  feeds it (`worker/src/config/satvis.core.yaml`), and the whole CelesTrak
  **SATCAT** fetched at refresh time (`worker/src/gp/satcat.ts`). Curated wins
  field by field, so a hand-written row extends its upstream row rather than
  replacing it. Either way a fact is stated once, no matter how many groups
  carry the satellite (`mergeSatelliteTables`).
- **SATCAT**: CelesTrak's satellite catalog, and the upstream half of the
  satellite table — owner, launch date and site, operational status, orbit type.
  Not a group source: it selects nothing and serves no records, it only says what
  is true of a satellite some group already carries, which is why it is fetched
  on its own and why losing it costs enrichment freshness and no group. Kept as
  a stored snapshot rather than re-downloaded, because the fetch is conditional
  and the usual answer is 304 (`docs/adr/0006-satcat-enrichment.md`).
- **Satellite metadata**: the bag of static facts a GP record carries beside its
  element set, interpreted by the frontend (`src/config/satelliteMetadata.ts`).
  Three provenances, and a reader has to know which one a field came from to
  know what its absence means: **curated** facts are
  hand-written for the couple of dozen satellites worth it, **upstream** facts
  come from SATCAT for every satellite there is, and both are attached by the
  worker at refresh time and opaque to it; the **derived** orbit class is instead
  computed by the frontend as it parses, because it follows from the element set
  every satellite already has. Provenance is per field, not per bag: a satellite
  absent from both tables still carries its orbit class, and falls back to app
  defaults for the rest.
- **Swath extent**: the cross-track distance from the ground track to the edge of
  a sensor's footprint, held per side (starboard = velocity bearing + 90°). Not
  half a width: the sides differ when a sensor is tilted, so a swath is a pair of
  extents, and their sum is the total width.
- **Orbit class**: the orbit's regime — LEO, MEO, GEO or HEO — derived from the
  element set, never configured, so every satellite has one and it cannot
  contradict its own orbit (`orbitClassOf`). One class, three readers: it decides
  the colour of the satellite's point, the badge on its row in the browser, and
  whether it is drawn a ground track and a sensor cone at all.
- **Tag**: a label attached to satellites by the group that supplied them, and
  the unit the user activates ("enable Weather"). A tag belongs to the group in
  the config, not to a preset or a client, so it means the same everywhere. One
  satellite may carry tags from several groups. Tag names must not contain a
  comma.
- **Component**: one visual representation of a satellite that can be switched
  on independently — point, label, orbit, orbit track, ground track, sensor
  cone, 3D model. Component names must not contain a comma.
- **Activation**: which catalog entries should currently exist as live
  satellites — tag-enabled entries minus per-satellite opt-outs, plus
  name-enabled entries, plus the tracked satellite. Carried as three lists
  (enabled tags, enabled satellites, disabled satellites) that are only
  meaningful together: none of them can be validated without the other two
  (`src/modules/satelliteActivation.ts`).
- **Ground station**: a named position on the ground that passes are computed
  against. They are ordered, but the order is presentation only: which one the sky
  view stands at is a designation carried beside the list (`sat.observerStation`),
  not a rank within it. So the ground station panel is a list in order, editable in
  place, with the observer marked — and the mark is the control that moves it.
- **Tracked satellite**: the satellite the camera follows. At most one, and the
  only value the globe reports back rather than merely receiving. Mutually
  exclusive with the sky view, which owns the camera itself: while the sky view
  is the active view mode nothing is tracked, and any attempt to track is
  undone.
- **Observer**: the point on the ground the sky view looks up from — the ground
  station designated as such, the first by default. Not a separate location:
  whoever the observer is, passes are already computed against them. It must be
  resolved before the sky view can open; where there is no ground station yet, the
  device's own location becomes one and is designated, and the sky view does not
  open if that is refused. Movable while the view is up — the movement keys walk
  it, and the designated station follows once they stop (`SkyMovement`), keeping
  its name and its place in the list. Designating a different station while the
  view is up moves the view there.
- **Eye height**: how far the sky view's camera is above the ground under the
  observer. Standing height by default and raised by the movement keys, up to a
  ceiling that keeps "looking up from a point on the ground" a fair description.
  The view's, not the observer's: it is absent from the ground station and from
  the url, because a pass is computed against a point on the ground however high
  the eye is held above it.
- **Pass**: a time range in which a satellite serves a ground station — by
  line-of-sight elevation ("elevation" mode) or sensor footprint overlap
  ("swath" mode). In swath mode which side of the ground track the station lies on
  matters, because a tilted sensor reaches further one way than the other.
- **Pass predictor**: the single owner of pass prediction for one satellite:
  ground stations, overpass mode, the recompute window guard, the computed
  pass list, and its Cesium time intervals (`PassPredictor`).
- **Overpass mode**: how passes are computed — "elevation" or "swath".
- **View mode**: where the viewer looks at the world from, and in what
  projection — the globe in 3D, 2D or Columbus, or the sky from a point on the
  ground. Exactly one is active. The app's own vocabulary, not Cesium's: three
  of the four coincide with a Cesium scene mode and the sky view does not
  (`src/config/viewModes.ts`).
- **Camera mode**: the reference frame the camera is pinned to — earth-fixed or
  inertial. Independent of the view mode.
- **Sky view**: the view mode that stands at the observer and looks up, showing
  satellites where they actually are in that person's sky. It owns the camera
  outright, which is why nothing is tracked while it is up. What it stands on is
  whatever surface is there — terrain, or the top of a surface model, which means
  a roof where a building stands at the observer.
- **Aim**: which way the sky view is pointing — azimuth, pitch above the
  horizontal, and roll about the view axis. Pitch, not elevation: the two are
  equal whenever the camera is looking at something, but a camera has an
  attitude where a satellite has a position. Roll is only ever driven by the
  device's own orientation; nothing the user does with a pointer rolls the view,
  and taking the aim back by hand levels it rather than leaving a roll no pointer
  can straighten.
- **Field of view**: how much sky the view shows, held as the vertical angle
  because that is the one a phone's two orientations agree on. Zoom is a change
  to it and to nothing else: the aim does not move when the view zooms.
- **Heading reference**: where the device's idea of north comes from when the
  sky view aims by compass. Without one an orientation sensor gives a yaw from an
  arbitrary zero, so the sky view declines to aim by compass rather than aim at a
  bearing nobody measured (`docs/adr/0004-compass-aiming.md`). Compass aiming ends
  when the control says so or when a drag takes the aim back — the sensor rewrites
  the aim every reading, so the two cannot share it.
- **Lock**: the satellite the crosshair currently holds — the nearest one within
  the crosshair's reach that the observer can actually see, which is above the
  horizon and not behind the ground. What a tap acts on, and what the detail card
  and the on-sky track describe.
- **Live vs pinned time**: whether the viewer's clock follows the present or a
  moment the user chose. Live is the default. The clock becomes pinned only by
  a deliberate act — a time supplied in the URL, or scrubbing the clock deck's
  timeline — and stays pinned for the session, still advancing from that moment.
- **Clock deck**: the bottom controls that stand in for Cesium's animation and
  timeline widgets, which this app no longer builds on any device — pause,
  playback speed and scrubbing, in a control row over a scale row
  (`ClockDeck.vue`). Not a port of the two widgets: they are two instruments
  always both on screen, and this is one row that is either of them.
- **Scale row**: the deck's lower row, and the scale it is currently showing —
  the **timeline** of wall-clock time, or the **speed ladder** of playback rates.
  One at a time, switched from the control row, both dragged by the same gesture.
  Its height is fixed by the row rather than by either scale, so switching moves
  nothing above or below it.
- **Rung**: one detent of the speed ladder, from Cesium's own shuttle-ring ticks
  (1× to 86400× either way). The ladder rests on a rung, never between two.
- **Sampled trajectory**: the sliding sample window of a satellite's position
  (half an orbit back, 1.5 forward) in both the fixed and inertial frames,
  kept fresh as time advances (`SampledTrajectory`). The two frames are not
  produced alike: samples arrive already in the fixed frame, and the inertial
  one is derived from them on demand — see **Pseudo-fixed**.
- **Lane**: one propagation worker together with the traffic bound for it. A
  satellite belongs to exactly one lane for the life of the session, decided by
  a pure function of its satnum (`laneIndexFor`). That is what lets the pool
  keep one satrec per satellite rather than one per satellite per worker, and
  what makes a single record-sent set true for the whole pool
  (`src/modules/util/sampleSource.ts`).
- **Pseudo-fixed**: the Earth-fixed frame the samples are stored in — TEME
  rotated about Z by the Greenwich hour angle, treating UTC as UT1. It needs no
  loaded data, so the propagation worker produces it and the main thread stores
  what it is sent. The true inertial frame (ICRF) does need Cesium's IAU data,
  so it stays on the main thread and is charged only to the trajectories that
  draw an orbit (`src/modules/util/temeToFixed.ts`).
- **Group store**: the persistence seam of the GP refresh pipeline —
  readIndex/writeGroup/writeIndex — with a Workers KV adapter (cron/API) and
  a disk adapter (static `data/gp/` snapshot) (`worker/src/gp/store.ts`).
- **GP source**: where the frontend gets GP data — the worker API when the
  probe succeeds, the static `data/gp/` snapshot otherwise, with a
  per-request API→static fallback mid-session (`src/modules/util/gpSource.ts`).
- **Surface model**: the 3D representation of the ground and what stands on it,
  drawn over the globe. At most one, and none by default. Deliberately not
  symmetric: OSM Buildings adds extruded footprints to the globe's own surface,
  while Google Photorealistic 3D Tiles _is_ the surface — ground, vegetation and
  buildings in one mesh — which is why choosing it hides the globe and leaves the
  imagery and terrain selections describing nothing
  (`docs/adr/0005-surface-models.md`).
- **Inert**: said of a control whose selection is no longer describing what is on
  screen, because a surface model has taken over what it describes. Not the same
  as suppressed: suppression is about the store keeping a value that is not in
  force, inert is about the menu admitting it. A control can be inert and still be
  the user's to change — a hidden globe leaves the imagery choice theirs — or
  inert and not, where a terrain has been imposed.
- **Ground height source**: where the sky view's eye height comes from when the
  globe cannot say. The globe answers from loaded tiles every frame for free; a
  surface model has to be asked, once per observer, and answers with the top of
  whatever stands there (`SkyView.setGroundHeightSource`).
- **Basemap and overlay**: the two kinds of imagery layer. A basemap is the map of
  the world itself, so at most one is drawn; an overlay is data laid on top of it,
  and any number can be. Which kind a layer is, is a fact about the layer rather
  than about the selection (`base` on its registry entry), and it decides both the
  invariant and the control the menu offers.
- **Offline imagery**: the basemap that ships inside the app and is precached, so
  it is the only one guaranteed with no network. The high-resolution copy of the
  same map is data shipped beside the app and cached only as it is viewed: same
  map, different promise, which is why they are two selectable layers and not one.
- **Preset**: the per-route starting configuration — a title, the groups to
  register, and default values for url parameters. Defined in the worker config
  and served with the group index, so every client starts from the same ones; a
  client ignores a default it has no use for. A preset supplies defaults, not
  initial state: the URL carries only deviations from the preset's values, so
  the same query string means different things on different routes.
