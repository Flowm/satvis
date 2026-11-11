# [satvis.space](https://satvis.space) [![CI](https://github.com/Flowm/satvis/actions/workflows/ci.yml/badge.svg)](https://github.com/Flowm/satvis/actions/workflows/ci.yml)

3D satellite tracker and pass predictor.

Satvis is a free, open-source satellite tracker that runs in the browser.
It draws more than 16,000 satellites on a 3D globe in real time: Starlink, GPS, weather satellites, the ISS and many more.
Set your location and it predicts when each one passes overhead.
The sky view shows the sky from where you stand.
Point your phone up to see the satellites in that direction.

![Screenshot](https://user-images.githubusercontent.com/1117666/47623704-f0c3e900-db14-11e8-9cf9-7bf13acb267c.png)

## Features

- Visualize satellites on a 3D globe in real time, propagated in the browser with SGP4 from CelesTrak GP element sets (OMM/TLE)
- Show points, labels, orbits, orbit tracks, ground tracks, sensor cones, 3D models and ground station links per satellite, colored by orbit class (LEO, MEO, GEO, HEO)
- Switch catalog groups on and off (Starlink, GNSS, weather, Earth observation, crewed stations), or search for a single satellite
- Browse the whole catalog in linked charts: filter by launch year, orbit shape, sun-sync crossing time, constellation, country, operator and more, then show the matches on the globe
- Select a satellite to see its orbit, its next passes over your locations and its spacecraft details: country, operator, manufacturer, bus, mass and size
- Track a satellite: the camera flies to it and follows it along its orbit
- Save your location or any point you pick on the map, then list the upcoming passes over it and get a local browser notification before one starts
- Find satellites overhead in the ground-level sky view, aimed by dragging or by pointing your phone
- See which satellites you could spot: the sky view dims those in Earth's shadow, too far away or in a daylit sky
- View the globe in 3D, flattened to 2D or in Columbus view, over a base map, star field and terrain you choose
- Add OpenStreetMap buildings to the globe, or Google's photorealistic tiles under the sky view
- Start from the featured views, bookmark your own, and share any view as a link: the url carries the satellites, the components, the locations and the map layers
- Install it as a Progressive Web App and keep using it offline, from a cached element-set snapshot and base map
- Deploy it serverless: static files on a CDN, with an optional Cloudflare Worker serving fresh satellite data

Every parameter in that url, with its accepted values and default, is listed in the [url parameter specification](docs/adr/0001-url-parameter-specification.md#parameters).
For example, `?tags=&sats=NOAA+20+(JPSS-1),METEOR-M2+3&elements=Point,Label,Orbit&gs=48.1371,11.5754` shows only those two satellites, with their orbits and their passes over Munich.

## Built With

- [CesiumJS](https://cesiumjs.org)
- [Satellite.js](https://github.com/shashwatak/satellite-js)
- [Vue.js](https://vuejs.org)
- [Nuxt UI](https://ui.nuxt.com)
- [Cloudflare Workers](https://workers.cloudflare.com)
- [Workbox](https://developers.google.com/web/tools/workbox)

## Development

### Setup

```
git submodule update --init  # the 3D models in data/models
mise trust && mise install   # toolchain from mise.toml
mise setup                   # pre-commit hooks
pnpm install                 # the SPA and the worker/ package
```

### Run

- `pnpm dev` starts the dev server. It proxies `/api` to <https://satvis.space>,
  so satellite data works without a local worker. `pnpm dev:host` also exposes it
  on the local network.
- `pnpm build` builds into `dist/`; `pnpm preview` serves that build.
- `pnpm update-gp` refreshes the static satellite-data snapshot
  ([Worker-less deployments](#worker-less-deployments)).
- `pnpm update-imagery` builds the offline base map; it needs docker
  ([Offline base map](#offline-base-map)).
- `/models.html` (dev server only, not built) shows the 3D models side by side
  with their satellites, size, triangle count, textures and glTF problems: first
  the models the manifests map, then every other GLB under `data/`.

The 3D models live in the `data/models` submodule, which builds them itself
(`pnpm build` there, from its `build.yaml`). Its `models.yaml` maps NORAD ids to
models; a plugin with its own models adds a `models.yaml` at its root
([ADR 0007](docs/adr/0007-model-manifest.md)).

### Full-stack dev (with the worker)

To run the frontend against a local worker:

```
pnpm dev:worker                                     # wrangler dev on :8787
API_PROXY=http://localhost:8787 pnpm dev            # frontend proxies /api → local worker
```

A refresh fills Workers KV: the upstream tables first, then the GP data, which is
enriched from them. Each reports per source and needs a bearer token, because one GP
run pulls ~7 MB from CelesTrak against a 250 MB/day per-IP cap:

```
curl -X POST -H "Authorization: Bearer $REFRESH_TOKEN" http://localhost:8787/api/upstream/refresh
curl -X POST -H "Authorization: Bearer $REFRESH_TOKEN" http://localhost:8787/api/refresh
```

Then `GET /api/groups.json` lists the refreshed groups and
`GET /api/gp/starlink.json` returns an OMM element-set array.

Locally the token comes from `worker/.dev.vars` (copy `worker/.dev.vars.example`).
Deployed, it is a Worker secret: `wrangler secret put REFRESH_TOKEN`. With no
secret set, the endpoints return 503.

`POST /api/ingest` takes the same token and runs the same pass on payloads the
caller already downloaded ([Downloading off-Worker](#downloading-off-worker)).

### Deploy

`pnpm deploy` builds the frontend and deploys the worker. The worker needs a KV
namespace bound as `GP_KV` (`worker/wrangler.jsonc`). Run `pnpm update-imagery`
first ([Offline base map](#offline-base-map)).

After the first deploy, KV is empty until the first `push-catalog` and `push-gp`
([Downloading off-Worker](#downloading-off-worker)), in that order, so the groups
are enriched from the start. The deployed worker has no cron, so nothing else fills
it. `POST /api/upstream/refresh` fetches the tables from the Worker itself, since
planet4589.org does not firewall Cloudflare; CelesTrak's SATCAT still answers it with 522.

## Satellite data

Element sets come from [CelesTrak](https://celestrak.org) as OMM JSON
(CelesTrak is phasing out TLE for new objects). The Cloudflare Worker in
`worker/` fetches and serves them:

- `push-gp` refreshes each group into Workers KV from another machine
  ([Downloading off-Worker](#downloading-off-worker)). A failed source keeps its
  last-known-good copy.
- `GET /api/gp/<group>.json`: one group's element sets, as an OMM array with
  per-satellite metadata attached ([Satellite metadata](#satellite-metadata)).
- `GET /api/groups.json`: the group index. The frontend also uses it to probe
  for the worker.
- `GET /api/status`: how fresh each upstream table and each group is, with
  `stale: true` past a threshold, for an uptime monitor.

### Downloading off-Worker

CelesTrak firewalls by IP, and Cloudflare's Worker egress addresses are shared
across tenants. So a Worker gets `HTTP 522` on every source while the same URLs
work from anywhere else. That is why the deployed worker has no cron: every run
failed, and marked every group failed in the index while the data was fresh.

`pnpm --filter satvis-worker push-gp` runs the worker's download logic on your
machine (a CI runner, a VPS, a laptop) and POSTs the payloads to
`POST /api/ingest`, which runs the normal evaluate/enrich/store pass. Only the
download moves; the worker still owns the config, the evaluation and KV.

```
SATVIS_REFRESH_TOKEN=<token> pnpm --filter satvis-worker push-gp
```

`SATVIS_INGEST_URL` overrides the target (default `https://satvis.space/api/ingest`).
Run it on a schedule, at most every 6 h: a run costs ~7 MB, and CelesTrak asks
for one download per update.

The upstream tables, SATCAT, GCAT and CEOS, travel apart from the GP data, with their own
script, run daily ([Satellite metadata](#satellite-metadata)):

```
SATVIS_REFRESH_TOKEN=<token> pnpm --filter satvis-worker push-catalog
```

It reads each table's stored `ETag` from `/api/status`, downloads only what
changed, and reports every table to `PUT /api/upstream/<name>`: the new file as the
body with upstream's ETag in `X-Upstream-ETag`, or no body with
`X-Upstream-Status: 304` or `X-Upstream-Error: <message>`. `SATVIS_API_URL` overrides the worker
(default `https://satvis.space`). It waits 2 minutes between tables, so a run takes
about 9: a report of a new file or a 304 costs the Worker more CPU than Workers Free
allows, and back to back they get a 503. `SATVIS_TABLE_PAUSE_MS=0` skips the wait
against a local `wrangler dev`. It exits non-zero when a table was not refreshed.
`POST /api/upstream/refresh` does the same from the worker itself, behind the same
token.

### Configuration

Configuration is declarative YAML. Each config file has three independent
sections: `groups` (what is served, as which unit, under which tags), `presets`
(the starting configuration of a route) and `satellites` (static per-satellite
facts, keyed by NORAD id). Tags and presets reach clients with the group index,
`/api/groups.json`. `worker/src/gp/types.ts` documents every field.

- The core config is `worker/src/config/satvis.core.yaml`: the CelesTrak groups,
  the `default` preset, and the curated satellite table.
- A plugin adds `data/custom/<plugin>/satvis.yaml`. Groups take `sources`,
  `select`, `satellites`, `include`, `exclude` and `extraRecordsFile`.
  Example (`data/custom/example/satvis.yaml`):

  ```yaml
  groups:
    - name: iss
      sources: [{ celestrak: stations }]
      satellites:
        - { noradId: 25544, upstreamName: ISS (ZARYA), name: ISS }
  ```

- A preset named `x` opens at `/x`. Its `defaults` are url parameters
  ([ADR 0001](docs/adr/0001-url-parameter-specification.md)). Every route except
  `/` also needs a rewrite in `public/_redirects`, like the one for `/ot`.
- A preset's `featured` bookmarks are its route's Featured tab in the Bookmarks
  panel ([ADR 0011](docs/adr/0011-bookmarks.md)): each a `name`, a `thumbnail` and
  a `query` of url parameters against the preset's `defaults`, none for the default
  view. `pnpm update-showcase` takes each picture at its `pictureAt`, a moment
  close to today: the element sets are today's, except the orbits pinned in
  `scripts/showcase/pinned.json`, for a close-up of one satellite, which then holds
  its moment for good. It writes a plugin's to
  `data/custom/<plugin>/showcase/`, which the plugin's `sync.sh` copies to
  `showcase/` in its output, so they are served as `data/showcase/<name>.webp`:

  ```yaml
  presets:
    - name: x
      defaults: { tags: Weather }
      groups: [weather]
      featured:
        - { name: Weather satellites, thumbnail: data/showcase/x-weather.webp, pictureAt: 2026-10-30T08:00Z }
        - { name: Weather on a map, thumbnail: data/showcase/x-map.webp, pictureAt: 2026-10-30T08:00Z, query: { scene: 2D } }
  ```

  The script needs a GPU, the network, `pnpm update-imagery`, `pnpm update-starmap`
  and the models submodule, and says which is missing. It runs the app on Vite's dev
  server, so set `API_PROXY` to a local worker for a preset not yet deployed;
  `pnpm update-showcase "Weather on a map"` retakes one. To pin the ISS instead, record
  its element set as a group serves it, and pick a `pictureAt` within a day or two of
  its epoch:

  ```bash
  curl -s https://satvis.space/api/gp/stations.json | jq '[.[] | select(.NORAD_CAT_ID == 25544) | del(.metadata)]' > scripts/showcase/pinned.json
  ```

`pnpm --filter satvis-worker generate-groups` merges the core config, every
`data/custom/*/satvis.yaml` (with `extraRecordsFile` element sets inlined) and the
model manifests into the gitignored `worker/src/config/satvis.generated.json`.
The worker scripts run it themselves.

A plugin can also ship files: `pnpm update-custom-data` runs each
`data/custom/<plugin>/sync.sh` and collects the output in `data/custom/dist/`,
which the build copies into `data/`. The privacy policy linked from the credits
ships this way.

### Worker-less deployments

For static hosting without a worker, run `pnpm update-gp` before `pnpm build`.
It runs the worker's refresh pipeline, metadata enrichment included, and writes a
static snapshot to `data/gp/` (`<group>.json`, `index.json`; gitignored). At
runtime the app probes `/api/groups.json` and, if that fails, uses the snapshot,
so all presets work without the worker.

### Self-hosting with Docker

The `Dockerfile` serves the app and the worker from one container. The worker
runs on workerd through wrangler's local runtime (`worker/scripts/serve.mjs`). KV
is stored as SQLite in `/data`, and `serve.mjs` calls `POST /api/refresh` every 6 h
and `POST /api/upstream/refresh` daily: a self-hosted container is not behind
Cloudflare's firewalled egress. A fresh volume refreshes both once at startup.
Without `REFRESH_TOKEN`, `serve.mjs` makes up a token only it knows.

```sh
docker build --build-arg BUILD_SHA=$(git rev-parse --short HEAD) -t satvis .
docker run -p 8080:8080 -v satvis-data:/data -e REFRESH_TOKEN=... satvis
```

`compose.yaml` does the same with `docker compose up --build`. It reads
`REFRESH_TOKEN`, `BUILD_SHA`, `VITE_CESIUM_ION_TOKEN`, `VITE_POSTHOG_KEY` and
`PORT` from the shell or a `.env` file.

Run `git submodule update --init` and `pnpm update-imagery` before you build, or
the image has no 3D models and only base-map levels 0–2. Pass
`--build-arg VITE_CESIUM_ION_TOKEN=...` for terrain and the surface models: the
committed token only works on satvis.space. Keep the image private if
`data/custom/` holds private plugins.

### Offline base map

The `NaturalEarth` layer is the default base map and the one that works with no
network. Levels 0–2 are committed (42 WebP tiles, 0.35 MB), so a fresh clone renders
a correct globe. Levels 3–5 are generated:

```
pnpm update-imagery
```

This runs a container (`scripts/imagery/`) that fetches [Natural Earth
II](https://www.naturalearthdata.com/downloads/10m-raster-data/) at 10m, applies the
colour grade of the original Cesium tileset, and writes levels 3–5 to the gitignored
part of `data/imagery/`: about 17.2 MB, a minute on a warm cache. The host needs only
docker; GDAL runs in the container.

The build raises the zoom ceiling when it finds those levels. Without them the globe
still works, capped at level 2, and goes soft when you zoom in. The build says nothing,
so run the generator before `pnpm deploy`. A running `pnpm dev` needs a restart to
pick up the new levels.

The service worker precaches levels 0–3 (1.4 MB), so the whole globe works offline.
Levels 4 and 5 are cached as they are requested; where you have not been, level 3 is
magnified. `pnpm update-starmap` does the same for the optional star maps.

### Satellite metadata

Static per-satellite facts are keyed by NORAD id in one satellite table
([CONTEXT.md](CONTEXT.md#catalog-and-data)). It has five contributors, and every
field has one of them as its owner
([ADR 0008](docs/adr/0008-gcat-and-field-ownership.md)):

- **Curated**: per-side swath extents, sensor cone FOV, mission type, and any
  upstream field it overrides.
  Hand-written in the `satellites` table of `satvis.core.yaml` and of any plugin
  config, for the few dozen satellites that need them
  ([ADR 0002](docs/adr/0002-static-satellite-metadata.md)).
- **Model manifests**: a satellite's `modelFile`, by NORAD id, or by GCAT bus for
  a constellation, applied at refresh time ([ADR 0007](docs/adr/0007-model-manifest.md)).
- **SATCAT**: launch date and site, operational status, orbit type and centre,
  from the CelesTrak [SATCAT](https://celestrak.org/satcat/) for every served
  satellite. Raw SATCAT codes go over the wire; `src/config/satcatCodes.ts` turns
  them into labels.
- **GCAT**: country, operator, purpose, class, manufacturer, bus, mass and size,
  from Jonathan
  McDowell's [GCAT](https://planet4589.org/space/gcat/) (CC BY 4.0) for payloads
  still in orbit. GCAT runs about twelve weeks behind on new satellites. The worker
  names GCAT's codes from its organisations table, and lists the values GCAT flags
  as estimates in `estimated`.
- **CEOS**: the instruments an Earth observation satellite carries, each with its
  full name, kind, waveband classes, finest resolution and nominal swath, from the
  [CEOS MIM Database](https://database.eohandbook.com) (CC BY 4.0), for the few
  hundred satellites its agencies report. A mission's NORAD id counts only where
  SATCAT's launch date confirms it
  ([ADR 0018](docs/adr/0018-ceos-instruments.md)).

A curated value wins field by field. The refresh attaches the merged facts to each
served record under a lowercase `metadata` key, so there is no rule matching in the
browser. A satellite in no table carries no metadata and gets the defaults in
`src/config/satelliteMetadata.ts`.

The five upstream tables (SATCAT, GCAT's catalog, organisations and payloads, and
CEOS's lists as one file) are stored in KV as the files upstream served, gzip-compressed, beside their parsed
rows, which each GP update reads. Every check parses the stored file again, a 304
too, so a parser change applies after the next `push-catalog`. They are stored
only by `push-catalog` and `POST /api/upstream/refresh`; a new file that does not
parse is refused and the stored one stands. Each download is conditional on the
stored `ETag`, so an unchanged table costs a 304; CEOS's is its snapshot version,
one small request before the 21 that make up its file, and again after them. `pnpm update-gp` keeps its copies
in `worker/.cache/<name>.gz`, outside `data/` because everything in `data/` ships;
deleting one costs a full download, 6.7 MB for SATCAT and 19 MB for GCAT's catalog.
A missing table leaves every group untouched, only less enriched
([ADR 0008](docs/adr/0008-gcat-and-field-ownership.md)).

## iOS App

The iOS app is native: SwiftUI, with the globe drawn by its own Metal renderer,
reading the same worker as the web app and scheduling pass notifications as
[UserNotifications](https://developer.apple.com/documentation/usernotifications)
([ADR 0009](docs/adr/0009-native-ios-app.md)). `ios/AGENTS.md` covers building
and testing it.

<p align="center"><a href="https://apps.apple.com/app/satvis/id1441084766"><img src="src/assets/app-store-badge.svg" width="250" /></a></p>

### Universal links

`public/.well-known/apple-app-site-association` sends `/ot` and any `/` with a query to
the app; a bare `satvis.space/` stays on the website. The file has no extension, so
`public/_headers` gives it the JSON content type Apple requires. Apple serves it from
a CDN cache; after a deploy, check
<https://app-site-association.cdn-apple.com/a/v1/satvis.space>.

The app side is the `applinks:satvis.space` entitlement. Before the CDN updates, test
with `applinks:satvis.space?mode=developer` and Developer Mode on the device.

## License

MIT License, see `LICENSE`.

## Acknowledgements

Inspired by a visualization developed for the [MOVE-II CubeSat project](https://www.move2space.de) by Jonathan, Marco and Flo.
