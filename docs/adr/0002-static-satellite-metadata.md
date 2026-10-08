---
status: accepted
---

# Static satellite metadata and per-side swath extents

Per-satellite facts used to reach the browser as a rule list. `appMetadataConfig`
held seven rules keyed by exact name or `namePattern`, and the worker served more at
`/api/metadata.json`. `SatelliteCatalog` fetched them, compiled their regexes,
merged every match over a defaults object, and memoized the result per entry
against a revision counter, because rules could arrive _after_ the entries they
applied to.

Two things were wrong with that. The patterns made unchecked claims:
`namePattern: "FENGYUN"` gave a 2900 km swath to Fengyun 2G and 4A, geostationary
satellites with no cross-track swath, which only the `isLeo` gate kept from being
drawn. And `swathKm` was one number, which cannot express a tilted sensor:
Sentinel-3's SLSTR reaches 1000 km to starboard and 500 km to port, and the app
carried 740 km, the nominal OLCI figure for a different instrument.

## Decision

**Facts are attached to the record at refresh time**, from a NORAD-keyed satellite
table in `satvis.core.yaml` (and plugin configs). The table is merged into the
generated config and applied by `SatelliteTable.enrich` inside `refreshGroups`. The worker
API and the static `data/gp/` snapshot both go through that path.

**Matching is by NORAD id only.** No patterns. A satellite gets a swath because
someone wrote its catalog number down, so the table is a 1:1 mirror of the upstream
prediction table it was transcribed from, and re-syncing is a diff.

**Swath is a pair of per-side extents**, as upstream has it, measured cross-track
from the ground track relative to flight direction.

The format is YAML because the extents are trustworthy only with their provenance
(which value is a published spec and which was calibrated against real product
footprints), and JSON cannot carry a comment.

### Consequences accepted

- **Six satellites lost their swath:** Fengyun 3A/3B/3C/3G/3H and METOP-SGA1 were
  covered only by `namePattern` and are absent upstream. They fall back to the
  200 km default (`DEFAULT_SWATH_KM`). An absent entry reads as "we do not know",
  where a pattern-derived number reads as data.
- **Sentinel-3's ground track roughly doubles**, 740 → 1500 km, and other extents
  shift ~1% (Terra 2330 → 2350, Sentinel-2 290 → 300, VIIRS 3000 → 3130) as
  calibrated values replace nominal ones.
- **Defaults after a deploy** until the next GP update rewrites KV: the next
  `push-gp`, or an authenticated `POST /api/refresh`. The deployed Worker has no cron
  since ADR 0008.
- **`/api/metadata.json` is gone**, with the browser-side matcher, the revision
  counter and the per-entry memo.

## The rendered swath and the predicted swath disagree

Pass containment uses the two sides separately. The ground track does not: it stays
a Cesium corridor of one width, `starboard + port`, centred on the track. So for
Sentinel-3A/B the corridor extends 750 km per side while passes use +1000/−500, and
a station inside the corridor on the port side gets no pass.

This is deliberate. Drawing it correctly needs a polygon with per-side vertex
offsets, a change to `Orbit`, `satelliteGraphics` and
`SatelliteComponentCollection` that is separate from getting the data right. Only two
satellites are affected, the corridor is within 250 km of truth on each side, and
the pass list, which people act on, is correct. The corridor is for orientation.

Revisit when a third asymmetric satellite appears, or when someone reports a missing
pass.

## Why containment compares distance, not cross-track offset

A per-side test on signed cross-track distance is wrong in a way that looks right.
Great-circle cross-track distance measures offset from the _track_, not from the
satellite. A station 1200 km straight ahead has zero cross-track offset, so it would
stay in-swath as long as the satellite stayed on that great circle, and the pass
would never end.

So the cross-track decomposition supplies only its **sign**, which picks the side
and so the extent. The magnitude compared against that extent is the great-circle
distance to the subpoint. The footprint is a half-disc per side.

For a symmetric swath this is the previous model, `distance <= total / 2`, so the 37
symmetric satellites kept their pass windows exactly. `Orbit.test.ts` asserts that
containment at the 400 km boundary does not depend on the side for a symmetric
swath.

An ellipse with a second, along-track bound was tried and dropped. Distance already
bounds the station in every direction, and the data has no along-track radius: it
had to be taken from the wider side, which judged a port-side station against a
starboard number.

The flight bearing comes from two subpoints 10 s apart (`BEARING_SAMPLE_MS`), not
from the velocity vector. `positionGeodetic` returns only the speed magnitude, and
rotating the ECI velocity into ECF without the ω × r term skews the bearing by a few
degrees, enough to flip the side for a station nearly along-track.

## Orbit class is derived, not configured

`operator` and `missionType` are static: CelesTrak's GP records have no such fields.
`orbitClass` follows from `MEAN_MOTION` and `ECCENTRICITY`, which every record has.
In the satellite table it would cover 39 satellites instead of 10,000 and would
eventually contradict the orbit beside it, so it never goes there.

It is still cached in the metadata bag, by `orbitClassOf` in `parseGpPayload`, on
the client. Both objections are about the served payload and the table: the
frontend classifies every record it parses and reclassifies on every load, so the
value cannot age against its orbit, and nothing is added to the wire.

The cache exists because the satellite browser classifies whole catalog pages at a
time, and a `CatalogEntry` holds a record with no satrec. Deriving from the record
is two number reads; via a satrec it would be ~10,000 SGP4 initialisations on the
main thread during a catalog load. The raw mean motion differs from the
SGP4-recovered one by ~1 part in 10,000, a hundredth of a minute at the LEO/MEO
boundary, which no classification depends on. So `orbitClassOf` is the only
definition.

This is the one field whose presence in the bag does not mean "the satellite table
had something to say". Read provenance per field, not per bag.

## Alternatives rejected

- **A `families` layer keyed by `namePattern`**, with nominal instrument swaths below
  the calibrated per-satellite ones. It would have kept the six satellites above and
  given new fleet members a value on launch day, but it brings back pattern matching
  and stops the table mirroring upstream.
- **Group-scoped metadata** (`satellites[].metadata` applying only within its group).
  A swath is not a fact about a group: a satellite in two groups would need the value
  twice, synced by hand. Row metadata instead lifts into the global table under the
  row's id.
- **Keeping a single `swathKm` total.** Simplest, and 37 of 39 satellites are
  symmetric, but it cannot represent the Sentinel-3 asymmetry, which is verified
  against real SLSTR granule footprints.
- **Enriching every record with a default bag** so `metadata` is always present.
  ~10,000 records would each carry the same defaults to say nothing. Defaults live in
  the frontend, and an absent key means "not in the table". (The client-side
  `orbitClass` gives every parsed record a bag, but it differs per satellite and is
  never served, so neither objection applies.)
- **Calling `orbitClassOf` at each call site instead of caching it.** The browser
  would classify the same entry on every recompute of the row list, and the class
  would have no single owner. `CatalogEntry.orbitClass` is that owner, and the only
  place a missing cache entry is handled.
