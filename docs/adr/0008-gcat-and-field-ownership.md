---
status: accepted
---

# GCAT as the satellite table's third contributor, and one owner per field

The satellite table has two contributors. **Curated** rows are hand-written in the
configs and model manifests, for a few dozen satellites (ADR 0002, 0007). **SATCAT**
gives every satellite its owner, launch, status and decay (ADR 0006). Neither says
what a satellite _is_: its bus, its maker, its mass and its size. Jonathan McDowell's
[GCAT](https://planet4589.org/space/gcat/) does, and ADR 0007's proposed bus rule for
constellation models depends on it.

A third contributor raises a question two did not: what happens when two upstream
sources both answer the same question. ADR 0006 settled curated against upstream
(curated wins, field by field), but it had only one upstream.

## What the sources say about the same satellites

Measured on the 2 October snapshot: 16,653 served satellites, CelesTrak's SATCAT of
6 October, and GCAT's `satcat.tsv` of 2 October.

**Coverage.** SATCAT covers all 16,653. GCAT covers 15,708, 94%. The 945 it lacks are
the newest launches: its satellite list runs about twelve weeks behind its launch
list.

**Where they overlap, they mostly mean different things:**

| Question    | SATCAT                                                              | GCAT                                                                                  | Agree                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner       | `OWNER`, the registering state, in CelesTrak's codes (`PRC`, `CIS`) | `State`, in GCAT's codes (`CN`, `RU`); `Owner` is the operating organisation (`SPXS`) | 81%, and the rest are code-system differences, not errors                                                                                                   |
| Launch date | the launch that registered it                                       | the launch that carried it                                                            | 99.6%; of the 65 others, 51 are launches around midnight dated a day apart, and 14 are ISS-deployed CubeSats, which SATCAT dates 1998-11-20, Zarya's launch |
| Status      | `OPS_STATUS_CODE`, operational (`+`, `P`, `B`)                      | `Status`, orbital (`O` in orbit, `DK` docked)                                         | not comparable                                                                                                                                              |
| Decay       | current within a day                                                | twelve weeks behind                                                                   |                                                                                                                                                             |

**Only GCAT has:** bus (15,525 of the served satellites), manufacturer and operator
(15,707), mass, length, diameter and span (15,708), and shape (15,703). Most sizes
are flagged as estimates: length on 81% of rows, span on 88%, mass on 12%.

## Decision

### One bag per satellite, and every field has exactly one upstream owner

The table stays what ADR 0002 made it: one metadata bag per NORAD id, attached to the
record at refresh time. The new rule is about who may write each field.

- **Every field belongs to exactly one upstream contributor.** Fields are owned in
  facets: the fields that describe one fact (a launch's date and site) have the same
  owner, so a record never shows GCAT's launch date beside SATCAT's launch site.
- **Curated rows may override any field**, as ADR 0006 has it.
- **Derived fields are computed after the merge**, from fields already in the bag.

| Facet        | Fields                                                          | Owner                                                                 |
| ------------ | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Registration | `country`                                                       | GCAT                                                                  |
| Launch       | `launchDate`, `launchSite`                                      | SATCAT                                                                |
| Status       | `opsStatus`, `orbitType`, `orbitCenter`, `decayDate`            | SATCAT                                                                |
| Design       | `bus`, `manufacturer`, `operator`                               | GCAT                                                                  |
| Physical     | `massKg`, `lengthM`, `diameterM`, `spanM`, `shape`, `estimated` | GCAT                                                                  |
| Purpose      | `category`, `class`                                             | GCAT                                                                  |
| Sensor       | `swathStarboardKm`, `swathPortKm`, `coneFovDeg`                 | curated only                                                          |
| Mission      | `missionType`                                                   | curated only                                                          |
| Model        | `modelFile`                                                     | curated (manifest NORAD ids); by `bus` once ADR 0007's proposal lands |
| Orbit        | `orbitClass`                                                    | derived, client-side (ADR 0002)                                       |

**No field falls back from one upstream source to another.** A chain such as "GCAT's
launch date, else SATCAT's" would mix two definitions of the same field, depending on
the satellite: a reader of a launch date could not tell which launch it means. Where
GCAT has the better answer, its facet moves to GCAT as a whole, in its own decision.

The ownership is checked, not trusted: each upstream parser declares the keys it
emits, and a test fails when two declarations share one.

### `owner` becomes `country`, from GCAT, and GCAT's owner is the `operator`

SATCAT's `OWNER` and GCAT's `Owner` share a name and answer different questions.
SATCAT's is the state or body the object is registered under; GCAT's is the
organisation that runs it (`SPXS`, SpaceX). Shown side by side, two rows called
"Owner" would contradict each other, so the registration question becomes `country`
and the operating one `operator`.

**`country` is GCAT's `State`, and SATCAT's `OWNER` is dropped.** SATCAT's column is
not a country for at least 386 served satellites, 2.4%: CelesTrak lists
intergovernmental and commercial owners under their own codes (ESA 69, SES 36,
Intelsat 36, O3b 33, Eutelsat 28, Globalstar 27, Inmarsat 14, Orbcomm 14, Arabsat 9,
EUMETSAT 8), and `TBD` for 112. GCAT's resolves a company to its country (SES to
Luxembourg, Intelsat to the US) and marks an intergovernmental owner with `I-`
(`I-ESA`, `I-EUM`). The cost is GCAT's lag: the newest satellites, about 6%, have no
country until GCAT catalogues them. The registration facet moves to GCAT whole, so
no record mixes the two.

**Countries are named by GCAT, like organisations.** GCAT's formal country names do
not read well in a panel ("Great Han People's Nation" for South Korea), but every
country and intergovernmental row in its organisations table has a short English name:
"South Korea", "Germany", "ESA", "EUMETSAT". The worker writes that.

**`operator` is GCAT's `Owner`, by name.** Nothing writes the field today: it is
declared in `SatelliteMetadata` and shown by the info panel, but no curated row sets
it.

The rename reaches records on the first refresh after the deploy. Until then the
stored groups still carry `owner`, so the country row is missing for at most one push
interval.

### The tables are stored as files, apart from the GP data

SATCAT and GCAT used to ride in the GP update: `push-gp` added them to its ingest
bundle, and the Worker parsed them and kept the parsed rows. That coupled two cadences
that have nothing in common (GP several times a day; SATCAT once or twice a day; GCAT
about weekly). It also meant a parser change, a new field, waited for upstream to
change its file before it applied, because a 304 reused the parsed rows. Now:

- **Four upstream tables**, each stored as the file upstream served, gzip-compressed,
  under `upstream:<name>`: SATCAT (`satcat`), and GCAT's catalog (`gcat`), organisations
  (`gcatOrgs`) and payloads (`gcatPayloads`, for `category` and `class`). Compressed,
  because GCAT's catalog is 18.4 MiB against KV's 25 MiB value limit, and it grows;
  gzip makes it 2.6 MiB, and decompresses to the file as downloaded.
- **Two paths store them, and only these.** `PUT /api/upstream/<name>`, which
  `push-catalog` calls, and the Worker's own fetch: `POST /api/upstream/refresh`, and
  the same refresh from the scheduled handler, which the Docker image fires daily with
  `CATALOG_CRON`. Both are conditional on the stored file's ETag, but only while the
  file is there: a status that outlived its file would otherwise make every download a
  304 and never bring the file back. A new file is parsed before it is stored, so an
  error page or a cut-off download is refused (422) and the stored file stands.
- **Every GP update reads them.** `refreshGroups` decompresses and parses the four
  files anew, about 160 ms, and enriches from them; it never downloads a table. A
  parser change applies at the next GP update. A table stored between two GP updates
  reaches the groups at the next one. A missing or unreadable table means enriching
  without it, as ADR 0006 has it: a table never fails a group.
- **A status per table**, as KV metadata on its own key, `status:<name>`: `updated`
  (the stored file's time), `checked` (the last time upstream answered with a file or a
  304), the ETag, size and rows, and the last error. `push-catalog` reports a 304 or a
  failed download with a `PUT` that carries no body (`X-Upstream-Status: 304`, or
  `X-Upstream-Error`). A failure records only the error, so a dead job and a table that
  keeps failing both show as a `checked` that stops moving; a 304 clears the error,
  since upstream still serves the stored file. KV caps metadata at 1024 bytes, so the
  error is cut to fit in bytes, and an ETag too long to be real is dropped.
- **`GET /api/status`**, public, gathers the statuses with one `list()`, says whether
  each table's file is `stored`, and adds each group's last write from the index. A
  table without its file, or not checked within its threshold (SATCAT 2 days, GCAT 10
  days), and a group not written within 12 hours, is marked `stale`, and so is the
  whole answer, which an uptime monitor can watch. `/api/groups.json` no
  longer carries upstream statuses.

The GP data keeps its ingest bundle. One push of CelesTrak's `active` would carry every
served satellite but 17 (rocket bodies and debris in `last-30-days` and `stations`),
but not the membership of the curated groups (`weather`, `resource` and the others),
so the GP sources stay as they are. `push-gp` is back to GP alone, an 8 MB bundle.

`update-static-gp` runs both steps against disk, the tables first, keeping them in
`worker/.cache/<name>.gz` beside their statuses.

### Only payloads still in orbit, and interned strings

A GP update holds the GP bundle twice while it parses it, and now parses the four
tables beside it, within a Worker's 128 MB. Replayed in Node under a heap cap, with the
real payloads and tables, a full GP update fits under 48 MB without the tables, and
needs more than 72 MB and less than 80 MB with all four. Node's figures rank the
options rather than predict workerd's peak. Two things keep the parsed GCAT small:

- **Only payloads still in orbit are kept**: 19,934 of 69,999 catalog rows. Objects
  that reentered, were deorbited, landed, failed at launch or flew suborbital (`R`,
  `D`, `L`, `F`, `S`, and the attached `AR`, `AL`, `AS`) are half
  the catalog, and rocket bodies and debris most of the rest. This costs the 15 of the
  ~15,700 served objects GCAT knows that are not payloads, rocket bodies and debris in
  `last-30-days`.
- **Parsed strings are interned as flat copies.** V8 keeps a substring of 13 or more
  characters (`Starlink V2MO`) as a slice of its source, so one such value kept the
  whole 19 MB file alive: 38 MB live after the parse, 17 MB with interning.

The organisations table names `manufacturer`, `operator` and `country`: GCAT's short
English name for a country or intergovernmental body, else its English name, else its
name. This reverses ADR 0006's "codes travel, labels resolve at display" for these
three, because the served satellites use 1,130 organisation codes, against SATCAT's
few dozen, and GCAT maintains the table. `category` and `class` are small, stable
vocabularies, so they travel as codes and `src/config/gcatCodes.ts` labels them.

### Estimates are marked

A GCAT value flagged `?` is carried, and its key is listed in `estimated`
(`estimated: [lengthM, spanM]`). Dropping estimates would drop 81% of the lengths. The
info panel shows an estimated value as approximate, and a consumer that needs a
measured value reads the list.

### What GCAT does not take over

SATCAT keeps launch, status and decay. It is current within a day, covers every
served satellite, and its status means operational status, which is what the info
panel shows.

## Consequences

- **The served payloads grow by about 15%**: 1,134 to 1,301 KB gzip for all groups.
  The names cost most in the small groups; `starlink.json`, where they repeat, grows 4%,
  681 to 708 KB.
- **945 served satellites, 6%, have no GCAT facts**, until GCAT catalogues them.
  Their country, design and physical facets are absent, which means "not known yet".
  Before this, SATCAT gave them an owner.
- **`SATCAT_OWNER` leaves `satcatCodes.ts`**, with the field it labelled.
- **Three requests a day to a site one person runs**, almost always 304s. A GP update
  asks planet4589.org for nothing.
- **Two scheduled jobs instead of one**: `push-gp` several times a day, `push-catalog`
  daily. KV is empty after a first deploy until both have run once.
- **`/api/groups.json` loses its `satcat` field**, which only `push-gp` read.
- **GCAT is CC BY 4.0.** The app credits "Data from J. McDowell, planet4589.org".
- **`SatelliteMetadata` documents each field's owner**, and its file header stops
  saying that the worker copies the bag without knowing its fields.

## Alternatives rejected

- **Joining GCAT at build time**, in `generate-groups`. Simpler, with no fetch in the
  worker, but every new satellite would wait for a deploy on top of GCAT's lag, and the
  generated config bundled into the worker would grow by about 1 MB.
- **Per-field fallback chains** across upstream sources. See above: one field, two
  meanings.
- **Replacing SATCAT with GCAT.** GCAT has no operational status, and runs twelve
  weeks behind on new satellites and on decays.
- **Keeping SATCAT's `OWNER` as `country`.** Full coverage, but a country row that
  says "SES" or "TBD" for 2.4% of satellites.
- **Storing the parsed rows**, as SATCAT's snapshot was. A parser change would wait for
  upstream to change its file, about a week for GCAT.
- **Storing the files uncompressed.** Readable in the dashboard, but GCAT's catalog
  would outgrow KV's 25 MiB value limit in about two years.
- **The tables in the GP ingest bundle**, trimmed by `push-gp`. It worked, but tied the
  tables' cadence to GP's and needed the trim to fit a Worker's memory.
- **Rebuilding the groups when a table is uploaded.** It would rewrite all 16 groups
  for facts that change weekly; the next GP update does it anyway.
- **Groups derived from GCAT's `category`** (`MET` for weather, `NAV` for GNSS) instead
  of CelesTrak's curation. Only `active` would then need downloading, but the groups
  would change content and lag twelve weeks for new satellites, and `cubesat` is not a
  purpose. Deferred: `category` is served, so it can be tried with data in hand.
- **A `/api/gcat.json` sidecar** fetched by the frontend. It would need its own
  cache, failure mode and client-side join, which ADR 0006 rejected for SATCAT.
- **Organisation codes in the frontend**, as `satcatCodes.ts` does for SATCAT. 1,130
  codes, maintained upstream, would go stale in a bundled table.
- **Country codes named by the browser**, mapping GCAT's few non-ISO codes (`F`, `D`,
  `J`) to ISO for `Intl.DisplayNames`. It works, but GCAT already has the names, and
  the intergovernmental bodies would need a table of their own anyway.

## Open questions

- **Can the deployed Worker reach planet4589.org?** Only a local workerd has tried it,
  where all four tables download and a repeat answers 304. Production does not depend
  on it: `push-catalog` stores the tables either way.
- **Should the launch facet move to GCAT?** It would date the 14 ISS-deployed
  CubeSats by their own launch, but needs GCAT's launch list for the site and leaves
  the newest satellites without a launch date.
- **`shape`** is free text with several spellings of each value ("Box + 2 Pan",
  "Box+2 pan"). Only runs of spaces are collapsed; it is otherwise carried as is until
  generic models need it normalised.
