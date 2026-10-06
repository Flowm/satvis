---
status: accepted; how SATCAT is fetched and stored, and `owner`, superseded by ADR 0008
---

> SATCAT no longer rides in the GP ingest bundle as a parsed snapshot: it is stored as
> the file CelesTrak served, apart from the GP data, and every GP update parses it
> (ADR 0008). Its `OWNER` column is no longer carried; `country` comes from GCAT.

# SATCAT as the satellite table's second contributor

ADR 0002 replaced pattern-matched metadata rules with a NORAD-keyed satellite table,
hand-written in `satvis.core.yaml`. That shape suits what it holds (swath extents and
sensor cones, calibrated and transcribed per satellite), but it covers **19
satellites out of the 12,594** the app serves. Every other satellite arrives as a
name, a catalog number and six orbital elements, and the app can say nothing about it
beyond the orbit class it derives.

CelesTrak's [SATCAT](https://celestrak.org/satcat/satcat-format.php) covers 100% of
the served satnums (verified against a full snapshot, zero misses) and carries owner,
launch date, launch site and operational status at ~100%.

## Decision

**SATCAT is a second contributor to the satellite table, not a group source.**

It selects nothing and serves no records; it only says what is true of a satellite
some group already carries. So it is fetched on its own (`worker/src/gp/satcat.ts`),
not through `collectSources`/`fetchSources`, and `mergeSatelliteTables` folds it into
the map `enrichRecords` consumes. **`enrichRecords` is unchanged**: the merge happens
before it, so the join, the satnum normalization and the "no entry, no `metadata` key"
rule stay as ADR 0002 left them.

**Curated wins field by field.** A YAML row with only a swath keeps SATCAT's owner and
launch date. The two tables do not compete: what is worth hand-writing is what SATCAT
does not carry.

**Codes travel, labels resolve at display.** `owner: "US"` is 2 bytes on 11,302
records where "United States" is 13. `src/config/satcatCodes.ts` maps them, and every
lookup falls back to the raw code: these tables go stale by design, and `SKOR` is a
better cell than a blank one.

`SatelliteMetadata` now has three provenances: **curated** (hand-written, ~19
satellites), **upstream** (SATCAT, all of them), and **derived** (`orbitClass`,
computed client-side, see ADR 0002). A reader must know which one a field came from to
know what its absence means. Nothing upstream may use the name `orbitClass`, because
`cacheOrbitClass` overwrites that key unconditionally.

## The fetch is conditional, because the cadence does not line up

CelesTrak moved to [one download per update](https://celestrak.org/usage-policy.php)
in March 2026. SATCAT refreshes **once or twice a day**; our cron runs every 6 h. An
unconditional fetch would pull 6.7 MB two to four times over for nothing, and
`pub/satcat.csv` is not served gzipped, so that is 6.7 MB on the wire each time.

It does serve an `ETag`. The stored snapshot keeps the validator from the body it came
from, and the next fetch sends it as `If-None-Match`. The steady state is a 304 with no
body, so **the stored snapshot is the normal input to enrichment**, not a fallback.

The Worker cannot fetch CelesTrak at all (CelesTrak firewalls Cloudflare's shared
egress, and every source returns HTTP 522), so the download runs off-Worker in
`worker/scripts/push-gp.mjs`, and the validator has to round-trip:

```
push-gp:  GET /api/groups.json           -> satcat.validator
          GET satcat.csv   If-None-Match -> 200 + body | 304
          POST /api/ingest { sources: [...groups, satcat] }
worker:   bundleFetch replays it by URL, ETag included
          304 or failure -> the stored snapshot stands
          200            -> parse, store snapshot + new validator
```

`worker/scripts/update-static-gp.mjs` runs the same path against a disk store with a
real `fetch`, so the two cannot diverge.

**A SATCAT failure costs enrichment freshness and nothing else.** `fetchSatcat` never
throws, and groups are fetched, evaluated and stored independently of it. A refresh
with no catalog writes every group as it would without SATCAT.

### Consequences accepted

- **~+8 KB gzip across all group payloads** (measured: `starlink.json` 656 → 663 KB
  gzip for 10,912 records, `stations.json` 1.4 → 1.8 KB), far below the projected
  +36 KB, because the values repeat and gzip removes them. Groups load on demand, so
  only people who enable Starlink pay for Starlink.
- **An 8.9 MB stored snapshot** of all 70,244 objects, not only the served ones.
  Trimming it to what the groups carry would leave a newly added group unenriched
  until the next 200, which defeats the conditional fetch.
- **One more upstream request per refresh**, almost always a 304.
- **The raw CSV travels in the ingest bundle** when the catalog changes, not a
  pre-parsed table. One parser, one format, and the Worker re-validates what it
  receives, the same fail-closed property the GP sources have.
- **`data/gp/` is not the only generated output.** The disk snapshot is
  `worker/.cache/satcat.json`, outside `data/` on purpose, because everything under
  `data/` ships in the build and this is never served.

## Fields not carried

`PERIOD`, `INCLINATION`, `APOGEE`, `PERIGEE`: derivable from the element set every
record has, and SATCAT rounds them to whole km and minutes. Serving them would put a
rounded second opinion beside the precise one.

`RCS`: 2.9% coverage on the served satellites (20.8% without Starlink, which has
none). `DATA_STATUS_CODE`: empty for all of them.

`OBJECT_TYPE`: 12,583 of 12,594 are `PAY`. Revisit only if a debris or rocket-body
group is ever served.

`OBJECT_NAME` and `OBJECT_ID`: the GP record already carries both.

## What this makes possible

`ORBIT_TYPE`/`ORBIT_CENTER` identify **12 objects that render as independent
satellites but are docked**: Nauka, Poisk, Crew Dragon, Progress and Cygnus on the ISS;
Wentian, Mengtian, Tianzhou and Shenzhou on the CSS; Soyuz-MS in `last-30-days`. They
propagate to nearly the same point as their host and stack eleven labels on the ISS.
Nothing else in the pipeline knows this, and the host is named:
`orbitCenter: "25544"`.

This ADR carries the data and shows `Orbit type: Docked` in the info panel. It does
**not** change how they are drawn. Nesting them under the host, or suppressing the
duplicate labels, is a rendering decision with its own design, and resolving a host
satnum to a name needs catalog access that `getSatelliteInfo` does not have.

`OPS_STATUS_CODE` and `DECAY_DATE` also run ahead of CelesTrak's group membership:
`science` served ODIN after its 2026-08-03 decay, and `planet` serves FLOCK 4BE-2 at
`ops=-`. The app can now say so.

## Alternatives rejected

- **`satcat/records.php?GROUP=active`**: 1.5 MB against 6.7 MB, but it drops 21
  served objects (rocket bodies and debris in `last-30-days`, and anything decayed
  since the last catalog roll). Being wrong about exactly the objects whose status is
  changing is the wrong trade, and the conditional fetch makes the size difference
  free in the steady state.
- **Generating the table at build time** into `satvis.generated.json`. Zero runtime
  cost, and owner, launch date and launch site never change. But `last-30-days` holds
  objects launched since the last build, which would never be enriched, and
  `OPS_STATUS_CODE`/`DECAY_DATE` are only worth having when current.
- **A separate `/api/satcat.json` sidecar** fetched by the frontend: 53 KB gzip for
  all 12,594 satellites, against ~8 KB inlined. Inlining is smaller in practice and
  lazy (it rides the group file the browser already fetches), and it needs no second
  cache entry, no second failure mode and no client-side join.
- **Making SATCAT a `SourceSpec`** so it flows through `collectSources`. That would
  reuse the fetch spacing and logging, but `parseOmmArray` validates every source as
  an OMM array, `SourceFetch.records` is typed `OmmRecord[]`, and `evaluateGroups`
  would carry a source no group names. That a SATCAT row happens to satisfy
  `OmmRecord` is no reason to call it one.
- **Storing only the served satnums.** It breaks when a group is added between two
  304s (see above).
- **Expanding codes to labels in the worker.** A bigger payload, and a correction
  would need a full GP refresh instead of a deploy.
