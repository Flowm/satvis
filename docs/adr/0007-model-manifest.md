---
status: accepted
---

# 3D models are mapped by NORAD id from model manifests

A satellite used to get its 3D model by name: the frontend asked for
`./data/models/<name, spaces as dashes>.glb`, and Cesium found a file there or did
not. That had three problems.

- **Every satellite without a model made a failed request.** Under `pnpm dev`, and
  behind the asset router's `404.html`, the answer was a page, not a model.
- **One model meant one file per satellite.** GRACE-FO 1 and 2, or eight FOREST
  satellites on one bus, each needed a copy. The models repo carried
  `GRACE-FO-1.glb` beside `GRACE-FO-2.glb` and `MOVE-II.glb` beside `MOVE-IIB.glb`,
  and `ot-models` kept FOREST-4 to 11 as symlinks to `OTC-P1.glb` until a clean-up
  deleted them and the satellites lost their models unnoticed.
- **Names drift.** A plugin renaming `ISS (ZARYA)` to `ISS` silently changed the file
  the ISS asked for.

## Decision

### A model manifest lists the satellites each model depicts

Every model repository has a **model manifest**, `models.yaml`: a list of model files,
each with the NORAD ids of the satellites it depicts. The `data/models` submodule
writes its manifest from its build recipe. A plugin with its own models, such as
`ot-models`, writes one by hand at its root. A `file` is the model's path under
`/data/models/` as served, wherever it was copied from.

What a model depicts is a fact about the model, so it lives with the model, not in
satvis's config. The models repository keeps its **recipe** (`build.yaml`: source,
nodes removed, rotation, scale, hand-written with the reasoning in comments) apart
from its **manifest** (`models.yaml`, written by `pnpm build`, never edited), because
a consumer needs the manifest and a reviewer needs the diff between them.

### The worker generator turns manifests into `modelFile`

`generate-groups` reads `data/models/models.yaml` and every
`data/custom/*/models.yaml`, and adds `modelFile: <file>` to each listed satellite in
the satellite table. From there it travels like other metadata: attached to records at
refresh time (ADR 0002), into the static snapshot, and read by the frontend as
`metadata.modelFile`, served from `./data/models/` (`modelUrl` in
`src/modules/satelliteGraphics.ts`). No endpoint, no browser-side matching, and the
manifest does not ship.

The bag carries the file, not a URL. Where models are served is decided by the app in
one place, and no payload repeats the prefix for every mapped satellite.

The mapping goes through the same table as every other fact, so the same rule holds:
two sources giving one satellite different values is a build failure that names both.
A plugin cannot quietly override a public model; it gets an error, and the mapping
changes in the models repository. One NORAD id belongs to one model, which the models
build also checks.

### No name lookup

A satellite without `modelFile` has no model. The 3D model component draws nothing for
it and requests nothing, and tracking does not wait for a model that will never load.
The name rule was kept until every satellite that matched a file by name was mapped,
checked against the GP snapshot: the ISS, LANDSAT 8, ICESAT-2, GRACE-FO 1, FOREST-2
and FOREST-3. An unmapped satellite gets no generic stand-in; a generic model in
`generic/` is drawn only for the buses it names (below).

Files keep the name of their first satellite (`GRACE-FO-1.glb` serves both GRACE-FO).
Nothing reads the name, and a name that matches a satellite costs nothing.

### A missing manifest warns

A checkout without `git submodule update --init`, CI included, has no
`data/models/models.yaml`. The generator warns and continues, so lint and tests run
anywhere. A deploy from such a checkout ships without public models; the warning says
so and names the fix.

## Consequences

- Giving a model to another satellite is one line in a manifest, and a constellation
  shares one file: one download, one cache entry.
- A mapping change reaches the app on the next worker deploy, because the generated
  table is bundled into the worker, or on the next `pnpm update-gp` for the static
  snapshot.
- Models a plugin copies into `/data/models/` without a manifest entry are reachable
  only by explicit URL, as `ot-models`' `grafana*/` copies are by its Grafana plugin.

## A constellation's models by bus

GCAT's `bus` reaches every record at refresh time (ADR 0008), which this rule depends
on.

A NORAD list suits a model with one satellite, or a pair. It does not suit a
constellation. Starlink is 11,152 tracked satellites in five generations, and in 2026
it gained about 250 a month (2,163 by 2 October). A hand-kept list is stale after the
next launch, and every diff is a few dozen numbers nobody can review.

What tells the generations apart, checked against the 2 October snapshot:

- **Name.** The number ranges are disjoint today: Direct to Cell is `STARLINK-11xxx`,
  V2 mini 30036–32961, V2 mini Optimized from 33531. But SpaceX publishes no such
  convention, and matching names is what ADR 0002 removed.
- **Launch.** 54 of 421 Starlink launches carried two generations: Direct to Cell
  satellites rode with V2 minis. A launch cannot carry one model.
- **Launch date.** The generations overlap: V2 mini launched until March 2025, V2 mini
  Optimized from December 2024.
- **GCAT's `Bus`.** Jonathan McDowell's catalogue names the bus of each satellite:
  `Starlink`, `Starlink V2M`, `Starlink V2MD`, `Starlink V2MO`. It covers every
  tracked Starlink except the 472 launched since 11 July. Its satellite list runs
  about twelve weeks behind its launch list.

### Decision

**A model manifest may name buses as well as satellites.** A bus is GCAT's string,
matched exactly. There are no patterns, and a bus belongs to at most one model across
all manifests, checked by the generator as NORAD ids are.

```yaml
- file: STARLINK-V2-MINI.glb
  buses: [Starlink V2M, Starlink V2MO]
```

What a model depicts is still a fact about the model: a bus is a design, and a model
depicts a design. The rule stays in the manifest, beside the file. A generic model
names a platform bus it shows only in outline: one CubeSat per size for GCAT's
`Cubesat 3U`, one comsat for the `Eurostar 3000` family.

**Matched at refresh time, where the bus is known.** The generator writes a bus →
`modelFile` map into the generated config (`modelBuses`). When the worker enriches a
record whose GCAT bus is in that map, it gives the record that `modelFile`. A satellite GCAT
catalogues next week gets its model on the next refresh, with no deploy and no
manifest change.

**A listed NORAD id wins over its bus.** A listed id is a claim about one satellite.
A bus is a claim about a family, and the specific claim overrides the general one,
as curated rows override SATCAT (ADR 0006). This leaves room to give one satellite of
a bus a different model.

v1.0 and v1.5 share the bus `Starlink` and so share a model. The visors and laser
terminals that tell them apart are invisible at the size satvis draws them.

### Consequences

- **The newest satellites have no model until GCAT catalogues them**, about twelve
  weeks: today 472 Starlinks, 4%, drawn as points. A missing bus means "not known
  yet", as an absent fact does in ADR 0002. Nothing guesses.
- **A new design needs a model, a manifest line and a deploy**, since the map is
  bundled into the worker. The 26 V3 Starlinks in orbit since 28 September have the
  first two, but get their model only once GCAT catalogues them under `Starlink V3`.
- **Coverage, on the 7 October snapshot:** 13,379 of 16,634 served satellites, 80%,
  get a model by NORAD id or bus, against 245 by NORAD id alone. Starlink alone is
  10,665, the generic CubeSats about 820, the generic comsats about 200.
- **The Starlink manifest is four entries**: v1, V2 mini, Direct to Cell and V3. It
  would otherwise be 11,152 ids.
- **GCAT is CC BY 4.0.** The app credits "Data from J. McDowell, planet4589.org".

### Alternatives rejected

- **The models build expands buses into NORAD lists** in `models.yaml`. It changes
  nothing in satvis, but puts 11,152 ids in the manifest, and freshness waits for a
  rebuild, a submodule bump and a deploy.
- **Name number ranges.** They work today, but the convention is unpublished, and it
  fails silently when SpaceX changes it.
- **COSPAR launch ids.** They fail on the 54 mixed launches.
- **A fallback to the current production model** for Starlinks GCAT has not
  catalogued yet, by name and launch date. It would close the twelve-week gap, but it
  is a guess, and it would draw the first V3s as V2 minis. If the gap matters, GCAT's
  launch list is the better fallback source: it is current, and it codes each launch's
  generation (`V2MO 17-46 (24 Ku)`).

## Lower-detail copies

satvis draws up to 200 models at once, most at their minimum of 20 to 72 points, and a
model costs its vertex work at any size. The ISS's 447,638 triangles cost an iPad mini 6
about 3 ms of GPU a frame whether it filled the screen or was 72 points wide, and the
native app held it as 128 MB of GPU memory. A copy simplified for that size, 42,109
triangles, looks the same there.

### Decision

**The manifest lists a model's copies beside its file**, most detailed first, each with
the largest on-screen size it is drawn at: its bounding sphere's diameter in points,
which both renderers already compute.

```yaml
- file: ISS-(ZARYA).glb
  lods:
    - { file: ISS-(ZARYA)-low.glb, maxPoints: 100 }
```

The models build writes them (data/models README). A copy is a fact about the file, as
the satellites it depicts are, so it lives in the manifest too.

**They travel in a `model` object, beside `modelFile`.** The generator writes a model
file → copies map into the generated config (`modelLods`), and the worker gives every
record with a model a `model`: whatever file it ends with, by NORAD id, by bus or from a
curated row, and that file's copies. The bus map stays a map of files.

```json
"modelFile": "ISS-(ZARYA).glb",
"model": { "file": "ISS-(ZARYA).glb", "lods": [{ "file": "ISS-(ZARYA)-low.glb", "maxPoints": 100 }] }
```

The record keeps `modelFile`, the same file, for the apps released before `model`: the
iOS builds in users' hands and the web builds service workers have cached read only
that. An app from now on reads `model`, and `modelFile` only in a payload cached before
`model` existed. `modelFile` can go once no supported app reads it.

**An app draws a copy while the model is small, and the file once it is not.** It
measures the copy it draws, which is within half a percent of the full model's sphere,
so the full model is not loaded at all while every satellite drawing it is small. Up,
it keeps the copy until the file has loaded; down, it waits for 0.8 of `maxPoints`, so a
model at the boundary does not flicker. The info panel's close-up always draws the file.

### Consequences

- An app released before `model` reads `modelFile` and draws the file at every size, as
  before.
- Every record with a model names its file twice until `modelFile` goes: about 40 bytes
  on each of some 13,000 records, before compression. Only the six models with copies
  today add `lods`.
- Both fields come from the satellite table, so they cannot disagree. A curated row
  still names `modelFile`; nothing authors `model`.
- Copies reach the app on the next worker deploy or `pnpm update-gp`, as `modelFile` does.

### Alternatives rejected

- **A `modelLods` field beside `modelFile`.** Fewer bytes, but one model in two fields,
  each read on its own, and a third for anything a model gains next.
- **Replacing `modelFile` with `model`.** Every shipped app would draw no models.
- **A table of copies served apart from the records.** One fetch less per record, but
  an endpoint and a manifest that ships, which this ADR rules out.
- **A naming rule**, `<file>-low.glb` at a fixed 100 points. It hides the threshold,
  which each copy's simplification follows, from the manifest.
- **Changing the model entity's `uri`** in the web app. Cesium destroys the model and
  loads the other, so it vanishes at every switch.
