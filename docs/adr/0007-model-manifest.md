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
and FOREST-3. Unmapped satellites get no generic stand-in yet; `generic/` holds
candidates for a later decision.

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
depicts a design. The rule stays in the manifest, beside the file.

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
- **Coverage, on the 2 October snapshot:** 12,608 of 16,653 served satellites, 76%,
  get a model by NORAD id or bus, against 245 by NORAD id alone. Starlink alone is 10,679.
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
