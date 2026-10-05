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
