# Domain glossary

Terms with a precise meaning in this codebase. Use these names in code and
discussion; sharpen them here when they drift.

## Catalog and data

- **Satellite**: one orbiting object, identified by a catalog entry (satnum +
  name) built from a GP element set (OMM or TLE).
- **Catalog**: the deduplicated registry of satellites across all loaded groups,
  with their tags merged (`SatelliteCatalog`). It does not resolve metadata: that
  arrives attached to the record.
- **Group**: a configured list of element sets, served as one unit
  (`/api/gp/<group>.json` or the static snapshot). A group decides what is served
  and under which name, never what is true of a satellite: that is the satellite
  table's job. A group can be the **remainder** of its sources after other groups
  are taken out (`exclude`), so one upstream list is served in disjoint pieces.
- **Search-only**: a group a preset registers with `searchOnly: true`. Its
  satellites are in the catalog and can be enabled one by one, but its tags get no
  group row and no place in the group multiselect.
- **Tag**: a label a group attaches to its satellites, and the unit the user
  enables ("enable Weather"). A tag belongs to the group in the config, not to a
  preset or a client, so it means the same everywhere. A satellite can carry tags
  from several groups. Tag names must not contain a comma.
- **Preset**: the starting configuration of a route: a title, the groups to
  register, and default url parameters. Defined in the worker config and served
  with the group index. A client ignores a default it has no use for. The url
  carries only deviations from the preset, so the same query string means
  different things on different routes.
- **Satellite table**: the static per-satellite facts, keyed by NORAD id and
  independent of the groups that serve those satellites. Contributors: curated
  rows from every config (`worker/src/config/satvis.core.yaml`, plugin configs),
  `modelFile` rows from the model manifests, and the CelesTrak **SATCAT** fetched
  at refresh time (`worker/src/gp/satcat.ts`). Curated wins field by field, so a
  curated row extends its upstream row rather than replacing it
  (`mergeSatelliteTables`).
- **SATCAT**: CelesTrak's satellite catalog: owner, launch date and site,
  operational status, orbit type. Not a group source: it selects nothing and only
  enriches satellites some group already carries, so losing it costs enrichment
  freshness and no group. Kept as a stored snapshot and fetched conditionally
  (`docs/adr/0006-satcat-enrichment.md`).
- **Satellite metadata**: the bag of static facts a GP record carries beside its
  element set, given meaning only by the frontend
  (`src/config/satelliteMetadata.ts`). Provenance is per field, and decides what
  an absent field means:
  - **curated**: hand-written for a few dozen satellites, attached by the worker;
  - **upstream**: from SATCAT, for every satellite, attached by the worker;
  - **derived**: the orbit class, computed by the frontend from the element set.

  A satellite in neither table still has its orbit class, and uses app defaults
  for the rest.

- **Model manifest**: a `models.yaml` that lists 3D model files and the NORAD ids
  each depicts: the `data/models` submodule's, and any plugin's. The generator
  turns it into each listed satellite's `modelFile`. A satellite no manifest lists
  has no model; models are never looked up by name
  (`docs/adr/0007-model-manifest.md`).
- **Group store**: the persistence seam of the GP refresh pipeline
  (`readIndex`/`writeGroup`/`writeIndex`, `readSatcat`/`writeSatcat`), with a
  Workers KV adapter (cron and API, `worker/src/gp/store.ts`) and a disk adapter
  for the static `data/gp/` snapshot (`worker/scripts/update-static-gp.mjs`).
- **GP source**: where the frontend gets GP data: the worker API when the probe
  succeeds, else the static `data/gp/` snapshot, with a per-request API → static
  fallback mid-session (`src/modules/util/gpSource.ts`).

## Satellites on the globe

- **Orbit class**: the orbit regime (LEO, MEO, GEO or HEO), derived from the
  element set and never configured, so every satellite has one and it cannot
  contradict its orbit (`orbitClassOf`). It sets the point colour, the badge in
  the satellite browser, and whether the satellite gets a ground track and a
  sensor cone at all.
- **Swath extent**: the cross-track distance from the ground track to the edge of
  a sensor footprint, per side (starboard = velocity bearing + 90°). A swath is a
  pair of extents, not a halved width: the sides differ when a sensor is tilted.
- **Component**: one visual part of a satellite that can be switched on on its
  own: point, label, orbit, orbit track, ground track, sensor cone, 3D model,
  ground station link (`src/config/components.ts`). Component names must not
  contain a comma.
- **Activation**: which catalog entries exist as live satellites: tag-enabled
  entries minus per-satellite opt-outs, plus name-enabled entries, plus the
  tracked satellite. Carried as three lists (enabled tags, enabled satellites,
  disabled satellites) that can only be validated together
  (`src/modules/satelliteActivation.ts`).
- **Tracked satellite**: the satellite the camera follows. At most one, and the
  only value the globe reports back. Mutually exclusive with the sky view: while
  the sky view is up nothing is tracked, and an attempt to track is undone.
- **Sampled trajectory**: the sliding window of a satellite's positions (half an
  orbit back, 1.5 forward) in the fixed and inertial frames, kept fresh as time
  advances (`SampledTrajectory`). Samples arrive in the fixed frame; the inertial
  frame is derived from them on demand (see **Pseudo-fixed**).
- **Lane**: one propagation worker and the traffic bound for it. A satellite
  belongs to one lane for the whole session, chosen by a pure function of its
  satnum (`laneIndexFor`), so the pool keeps one satrec per satellite and one
  record-sent set holds for the whole pool (`src/modules/util/sampleSource.ts`).
- **Pseudo-fixed**: the Earth-fixed frame the samples are stored in: TEME rotated
  about Z by the Greenwich hour angle, with UTC taken as UT1. It needs no loaded
  data, so the propagation worker produces it. The true inertial frame (ICRF)
  needs Cesium's IAU data, so it stays on the main thread and is computed only for
  trajectories that draw an orbit (`src/modules/util/temeToFixed.ts`).

## Passes and ground stations

- **Ground station**: a named point on the ground that passes are computed
  against. The list order is presentation only: which station the sky view stands
  at is a separate designation (`sat.observerStation`), not a rank. The ground
  station panel edits the list in place and marks the observer; the mark is the
  control that moves it.
- **Pass**: a time range in which a satellite serves a ground station, by
  line-of-sight elevation ("elevation" mode) or sensor footprint overlap ("swath"
  mode). In swath mode the side of the ground track the station is on matters,
  because a tilted sensor reaches further on one side.
- **Overpass mode**: how passes are computed: "elevation" or "swath".
- **Pass predictor**: the single owner of pass prediction for one satellite:
  ground stations, overpass mode, the recompute window guard, the pass list and
  its Cesium time intervals (`PassPredictor`).

## Views and camera

- **View mode**: where the viewer looks from and in what projection: the globe in
  3D, 2D or Columbus, or the sky view. Exactly one is active. The app's
  vocabulary, not Cesium's: the sky view is not a Cesium scene mode
  (`src/config/viewModes.ts`).
- **Camera mode**: the reference frame the camera is pinned to: earth-fixed or
  inertial. Independent of the view mode.
- **Sky view**: the view mode that stands at the observer and looks up, showing
  satellites where they are in that sky. It owns the camera, so nothing is tracked
  while it is up. It stands on whatever surface is there: terrain, or the top of a
  surface model (a roof, where a building stands at the observer).
- **Observer**: the point the sky view looks up from: the designated ground
  station, the first by default. Not a separate location, so passes are already
  computed against it. With no ground station, the device location becomes one
  and is designated; if that is refused, the sky view does not open. The movement
  keys walk the observer, and the designated station follows once they stop
  (`SkyMovement`), keeping its name and list position. Designating another station
  while the view is up moves the view there.
- **Eye height**: how far the sky view camera is above the ground under the
  observer. Standing height by default, raised by the movement keys up to a
  ceiling (`MAX_EYE_HEIGHT`). It belongs to the view, so it is not in the ground
  station or the url: a pass is computed against the ground point.
- **Aim**: where the sky view points: azimuth, pitch above the horizontal, and
  roll about the view axis. Pitch, not elevation: a camera has an attitude, a
  satellite has a position. Only the device orientation drives roll; taking the
  aim back by hand levels the view.
- **Field of view**: how much sky the view shows, held as the vertical angle
  because both phone orientations agree on it. Zoom changes only this, never the
  aim.
- **Heading reference**: where the device's north comes from when the sky view
  aims by compass (`HeadingReading` in `src/modules/DeviceAim.ts`). Without one
  the orientation sensor's yaw has an arbitrary zero, so the sky view does not aim
  by compass (`docs/adr/0004-compass-aiming.md`). Compass aiming ends from its
  control or when a drag takes the aim back, because the sensor rewrites the aim
  on every reading.
- **Lock**: the satellite the crosshair holds: the nearest one in the crosshair's
  reach that the observer can see (above the horizon, not behind the ground). A
  tap acts on it, and the detail card and on-sky track describe it.
- **Ground height source**: where the sky view's eye height is measured from when
  the globe cannot say. The globe answers from loaded tiles every frame; a surface
  model is asked once per observer and answers with the top of whatever stands
  there (`SkyView.setGroundHeightSource`).

## Map

- **Surface model**: the 3D ground and what stands on it, drawn over the globe. At
  most one, none by default. Not symmetric: OSM Buildings adds extruded footprints
  to the globe's surface, while Google Photorealistic 3D Tiles _is_ the surface,
  so choosing it hides the globe and leaves the imagery and terrain selections
  describing nothing (`docs/adr/0005-surface-models.md`).
- **Suppressed**: a stored value kept but not in force, for example `?camera=Inertial`
  under the sky view (`src/modules/util/Suppressible.ts`).
- **Inert**: a control whose selection does not describe what is on screen,
  because a surface model has taken over. Suppression is about the store; inert
  is about the menu saying so. An inert control can still be the user's to change
  (imagery under a hidden globe) or not (an imposed terrain).
- **Basemap and overlay**: the two kinds of imagery layer. A basemap is the map
  of the world, so at most one is drawn; any number of overlays lie on top. The
  kind is a fact about the layer (`base` in `imageryProviders`), and it decides
  both the invariant and the menu control.
- **Offline base map**: the `NaturalEarth` basemap, which ships with the app.
  Levels 0–3 are precached, so it is the only basemap guaranteed with no network;
  levels 4–5 are cached as they are viewed.

## Time

- **Live vs pinned time**: whether the clock follows the present or a moment the
  user chose. Live by default. The clock pins only on a deliberate act (a `time`
  in the url, or scrubbing the timeline) and stays pinned for the session, still
  advancing from that moment.
- **Clock deck**: the bottom controls that replace Cesium's animation and
  timeline widgets: pause, playback speed and scrubbing, as a control row over a
  scale row (`ClockDeck.vue`). One row that is either instrument, not a port of
  the two widgets.
- **Scale row**: the deck's lower row and the scale it shows: the **timeline** of
  wall-clock time or the **speed ladder** of playback rates. One at a time,
  switched from the control row, both dragged with the same gesture. Its height is
  fixed, so switching moves nothing else.
- **Rung**: one detent of the speed ladder, from Cesium's shuttle-ring ticks (1×
  to 86400× in both directions, `SPEED_TICKS`). The ladder rests on a rung, never
  between two.
