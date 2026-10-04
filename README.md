# [satvis.space](https://satvis.space) [![CI](https://github.com/Flowm/satvis/actions/workflows/ci.yml/badge.svg)](https://github.com/Flowm/satvis/actions/workflows/ci.yml)

3D satellite tracker and pass predictor.

Satvis is a free, open-source satellite tracker that runs in the browser.
It draws more than 12,000 satellites on a 3D globe in real time and works out when each one passes over a ground station you set.
The sky view trades the globe for a ground-level camera aimed by your phone's compass and gyroscope, so you look for the satellite in the sky rather than on a map of it.

![Screenshot](https://user-images.githubusercontent.com/1117666/47623704-f0c3e900-db14-11e8-9cf9-7bf13acb267c.png)

## Features

- Visualize more than 12,000 satellites on a 3D globe in real time, propagated in the browser with SGP4 from CelesTrak GP element sets (OMM/TLE)
- Draw points, labels, orbits, orbit tracks, ground tracks, sensor cones and 3D models per satellite, coloured by orbit class (LEO, MEO, GEO, HEO)
- Switch any of the 14 catalog groups on and off (Starlink, GNSS, weather, Earth observation, crewed stations), or search out a single satellite
- Set ground stations from geolocation or a point you pick on the map, then list their upcoming passes and get a local browser notification before one starts
- Show the globe in 3D, flattened to 2D or in Columbus view, over a base map, star field and terrain you choose
- Find a satellite in the sky overhead rather than on a map, in a ground-level sky view aimed by your phone's compass and gyroscope and walked with the movement keys
- Add OpenStreetMap buildings to the globe, or Google's photorealistic tiles under the sky view
- Share the exact view you are looking at as a link: the url carries the satellites, the components, the ground station and the map layers
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

Initialize submodules and install build dependencies:

```
git submodule update --init
mise trust && mise install   # toolchain (Node 24, pnpm 11, prek; see mise.toml)
mise setup                   # install the pre-commit hooks
pnpm install
```

A single `pnpm install` at the repository root installs dependencies for both
the SPA and the `worker/` package.

### Run

- `pnpm dev` for the dev server (proxies `/api` to <https://satvis.space>, so
  satellite data works without a local worker)
- `pnpm dev:host` to expose the dev server on the local network
- `/models.html` under `pnpm dev` shows every 3D model in `data/` side by side,
  with its satellites, size, triangle count, textures and glTF problems (dev only,
  not built)
- The 3D models live in the `data/models` submodule, which builds them itself
  (`pnpm build` there, from its `build.yaml`). Its `models.yaml` says which NORAD
  ids use which model; a plugin with models of its own adds a `models.yaml` at its
  root (`docs/adr/0007-model-manifest.md`)
- `pnpm build` to build the application (output in `dist` folder)
- `pnpm preview` to preview the production build locally
- `pnpm update-gp` to refresh the static satellite-data snapshot (see below)
- `pnpm update-imagery` to build the offline base map (needs docker; see below)

### Full-stack dev (with the worker)

To run the frontend against a local worker instead of the deployed API:

```
pnpm dev:worker                                     # wrangler dev on :8080
SATVIS_API_PROXY=http://localhost:8080 pnpm dev     # frontend proxies /api → local worker
```

The worker's cron trigger fills Workers KV. To run it once locally (wrangler
dev is started with `--test-scheduled`), hit the scheduled endpoint:

```
curl "http://localhost:8080/__scheduled?cron=23+*%2F6+*+*+*"
```

Then `GET /api/groups.json` lists the refreshed groups and
`GET /api/gp/starlink.json` returns an OMM element-set array.

`POST /api/refresh` runs the same refresh on demand and reports per-source
diagnostics. It needs a bearer token, since one run pulls ~7 MB from CelesTrak
against a 250 MB/day per-IP cap:

```
curl -X POST -H "Authorization: Bearer $REFRESH_TOKEN" http://localhost:8080/api/refresh
```

Locally the token comes from `worker/.dev.vars` (copy `worker/.dev.vars.example`);
deployed it is a Worker secret, set with `wrangler secret put REFRESH_TOKEN`.
With no secret set the endpoint returns 503 rather than running unauthenticated.

`POST /api/ingest` takes the same token and does the same work on payloads the
caller already downloaded, for when CelesTrak is refusing Cloudflare's egress
(see [Downloading off-Worker](#downloading-off-worker)).

## Satellite data

Element sets come from [CelesTrak](https://celestrak.org) as OMM JSON
(CelesTrak is phasing out TLE for new objects). The Cloudflare Worker in
`worker/` fetches and serves them:

- A cron trigger (every 6 h) refreshes each group into Workers KV; failed
  sources keep the last-known-good copy.
- `GET /api/gp/<group>.json` — one group's element sets (OMM array, with
  per-satellite metadata attached; see below).
- `GET /api/groups.json` — the group index (also the frontend's worker probe).

### Downloading off-Worker

CelesTrak firewalls by IP, and Cloudflare's Worker egress addresses are shared
across tenants — so the cron's own fetches can start coming back as `HTTP 522`
on every source while the same URLs answer fine from anywhere else. When that
happens, groups keep serving their last-known-good copy and go stale.

`pnpm --filter satvis-worker push-gp` is the way out. It runs the worker's own
download logic from wherever you run it (a CI runner, a VPS, a laptop) and POSTs
the payloads to `POST /api/ingest`, which runs the unchanged evaluate/enrich/store
pass on them. Only the download moves; the worker still owns the config, the
evaluation and KV.

```
SATVIS_REFRESH_TOKEN=<token> pnpm --filter satvis-worker push-gp
```

`SATVIS_INGEST_URL` overrides the target (default `https://satvis.space/api/ingest`).
Keep the cadence at or above the cron's 6 h — a run still costs ~7 MB of element
sets, just from a different IP, and CelesTrak asks for one download per update.

The same run also refreshes the SATCAT, reading the worker's stored `ETag` from
`/api/groups.json` first so its own download is conditional; the catalog's 6.7 MB
only travels when it actually changed.

Configuration is **declarative** YAML, not shell scripts. Each config file
contributes three independent sections: `groups` (what is served, as which unit,
under which tags), `presets` (the starting configuration of a route) and
`satellites` (static per-satellite facts, keyed by NORAD id). Tags and presets
reach clients with the group index, `/api/groups.json`.

- The core config lives in `worker/src/config/satvis.core.yaml` (CelesTrak
  pass-throughs, the `default` preset, and the satellite table).
- Plugins add `data/custom/<plugin>/satvis.yaml` with
  `sources` / `select` / `rename` / `include` / `exclude` / `extraRecordsFile`. Example
  (`data/custom/example/satvis.yaml`):

  ```yaml
  groups:
    - name: iss
      sources: [{ celestrak: stations }]
      satellites:
        - { noradId: 25544, upstreamName: ISS (ZARYA), name: ISS }
  ```

- A preset named `x` opens at `/x`. Its `defaults` are url parameters
  (docs/adr/0001), and a route other than `/` and `/ot` also needs a rewrite in
  `public/_redirects`.

`pnpm --filter satvis-worker generate-groups` merges the core config with every
`data/custom/*/satvis.yaml` (inlining `extraRecordsFile` element sets) into the
gitignored `worker/src/config/satvis.generated.json` used by the worker.

A plugin may also ship files: `pnpm update-custom-data` runs each
`data/custom/<plugin>/sync.sh` and collects the output into `data/custom/dist/`,
which the build copies into `data/`. The privacy policy behind the credits' link is
one of them.

### Worker-less deployments

For plain static hosting (or forks without a worker), run
`pnpm update-gp` before `pnpm build`. It runs the same refresh pipeline as the
cron — including metadata enrichment — and writes a static snapshot into
`data/gp/` (`<group>.json`, `index.json`; gitignored). At runtime the app probes
`/api/groups.json`; if that fails it falls back to the static `data/gp/`
snapshot, so all presets keep working without the worker.

### Offline base map

The `NaturalEarth` layer — the default base map, and the one that keeps the globe
usable with no network — is **part committed, part generated**. Levels 0–2 are in the
repository (42 WebP tiles, 0.35 MB), so a fresh clone already renders a correct globe.
The sharp levels are built on demand:

```
pnpm update-imagery
```

That runs a container (`scripts/imagery/`) which fetches [Natural Earth
II](https://www.naturalearthdata.com/downloads/10m-raster-data/) at 10m, applies the
colour grade the original Cesium tileset was cut with, and writes levels 3–5 into the
gitignored part of `data/imagery/` — about 17.2 MB more, and a minute on a warm cache.
Docker is the only host requirement; GDAL runs inside.

The build raises the zoom ceiling when it sees those levels, so skipping the generator
costs sharpness and nothing else: the globe still works, capped at level 2, and goes
soft when you zoom in. **Run it before `pnpm deploy`, though** — the build only warns,
so a deploy without it ships that cap. Running it during a `pnpm dev` session needs a
restart to take effect.

Levels 0–3 (1.4 MB) are precached by the service worker, so the globe is complete
offline wherever it is turned; 4 and 5 are cached as they are requested, and anywhere
you have not been shows level 3 magnified rather than nothing at all.
`pnpm update-starmap` does the same job for the optional star maps.

### Satellite metadata

Static per-satellite facts are keyed by NORAD id in one satellite table with two
contributors:

- **Curated** — per-side swath extents, sensor cone FOV, model URL, operator —
  hand-written in the `satellites` table of `satvis.core.yaml` (and of any plugin
  config), for the couple of dozen satellites worth saying something specific about.
- **Upstream** — owner, launch date, launch site, operational status, orbit type
  and centre — from the CelesTrak [SATCAT](https://celestrak.org/satcat/), which
  covers every satellite served. Raw SATCAT codes travel on the wire and are
  resolved to labels in `src/config/satcatCodes.ts`.

A curated value wins field by field, so a hand-written row extends its upstream
row rather than replacing it. The refresh attaches the merged facts to each served
record under a lowercase `metadata` key, so metadata travels with the element set
instead of being matched against a separate rule list in the browser. Satellites
in neither table carry no metadata and fall back to the defaults in
`src/config/satelliteMetadata.ts`.

The SATCAT fetch is **conditional**: the stored snapshot keeps the `ETag` it came
with and the next fetch sends it as `If-None-Match`, so the usual refresh costs a
304 with no body. CelesTrak asks for one download per update and the catalog only
changes once or twice a day, against a 6 h cron. `pnpm update-gp` caches its copy
in `worker/.cache/satcat.json` — outside `data/`, because everything there is
copied into the build and this is never served. Deleting it costs one full 6.7 MB
download. A SATCAT failure leaves every group untouched; it only costs enrichment
freshness. See `docs/adr/0006-satcat-enrichment.md`.

Swath extents are **per-side** cross-track distances from the ground track,
relative to flight direction — not halves of a total width, because a tilted sensor
reaches further one way than the other. See
`docs/adr/0002-static-satellite-metadata.md`.

## iOS App

To provide pass notifications on iOS where local browser notifications are [not
supported](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API#Browser_compatibility)
a simple app wraps the webview and handles the scheduling of
[UserNotifications](https://developer.apple.com/documentation/usernotifications).

<p align="center"><a href="https://apps.apple.com/app/satvis/id1441084766"><img src="src/assets/app-store-badge.svg" width="250" /></a></p>

### Universal links

`public/.well-known/apple-app-site-association` sends `/ot` and any `/` with a query to
the app; a bare `satvis.space/` stays on the website. It has no extension, so
`public/_headers` gives it the JSON content type Apple requires. Apple serves it from
a CDN cache: after a deploy, check
<https://app-site-association.cdn-apple.com/a/v1/satvis.space>.

The app side is the `applinks:satvis.space` entitlement. Before the CDN updates, test
with `applinks:satvis.space?mode=developer` and Developer Mode on the device.

## License

This project is licensed under the MIT License - see `LICENSE` file for details.

## Acknowledgements

Inspired by a visualization developed for the [MOVE-II CubeSat project](https://www.move2space.de) by Jonathan, Marco and Flo.
