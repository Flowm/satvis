import {
  ArcGisMapServerImageryProvider,
  type Clock,
  ArcGISTiledElevationTerrainProvider,
  CesiumTerrainProvider,
  createWorldTerrainAsync,
  EllipsoidTerrainProvider,
  type ImageryProvider,
  OpenStreetMapImageryProvider,
  type TerrainProvider,
  TileCoordinatesImageryProvider,
  TileMapServiceImageryProvider,
  UrlTemplateImageryProvider,
  WebMapServiceImageryProvider,
} from "@cesium/engine";

import { createGibsTimeLayer } from "./GibsTimeLayer";

// Always present — see data/imagery/.gitignore for what is tracked. How deep it goes
// is `__IMAGERY_MAX_LEVEL__`, decided in vite.config.ts, which is also where the
// reasoning lives.
const NATURAL_EARTH = "data/imagery/NaturalEarthII";

/** What a layer that follows the simulation time needs from the viewer it is added to. */
export interface ImageryContext {
  clock: Clock;
  requestRender: () => void;
  /** Aborted once the layer is removed, to stop listening to the clock. */
  signal: AbortSignal;
}

export interface ImageryProviderEntry {
  create: (context: ImageryContext) => ImageryProvider | Promise<ImageryProvider>;
  alpha: number;
  base: boolean;
}

export interface TerrainProviderEntry {
  create: () => TerrainProvider | Promise<TerrainProvider>;
  visible?: boolean;
}

export const imageryProviders: Record<string, ImageryProviderEntry> = {
  // The offline base map, and the default. Named for its source like every other
  // base layer here; there is only one, because both depths are now the same tiles
  // from the same generator and sharpness is the only difference.
  NaturalEarth: {
    // `maximumLevel` overrides the manifest, which declares only the committed
    // levels. It has to be passed at construction — the property is readonly, so a
    // ceiling cannot be raised afterwards.
    //
    // Above it Cesium magnifies the deepest tile it has rather than leaving a hole
    // (`TileImagery` walks up to the closest ready ancestor), which is what makes a
    // build without the generated levels soft instead of broken, and what covers
    // going offline somewhere the runtime cache has never been.
    create: () =>
      TileMapServiceImageryProvider.fromUrl(NATURAL_EARTH, {
        maximumLevel: __IMAGERY_MAX_LEVEL__,
        credit: "Imagery courtesy Natural Earth",
      }),
    alpha: 1,
    base: true,
  },
  ArcGis: {
    create: () =>
      ArcGisMapServerImageryProvider.fromUrl("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer", {
        enablePickFeatures: false,
      }),
    alpha: 1,
    base: true,
  },
  // Satellite and orthophoto imagery merged from several providers, free and
  // keyless. Served as TileJSON, which Cesium cannot consume, so the template and
  // the tile size below are transcribed from
  // https://tiles.versatiles.org/tiles/satellite/tiles.json — the one thing worth
  // re-checking if the imagery ever comes back wrong.
  VersaTiles: {
    create: () =>
      new UrlTemplateImageryProvider({
        // No `scheme` in the TileJSON, so the default `xyz` applies and Cesium's
        // own `{y}` is already the right way up; `{reverseY}` would invert it.
        url: "https://tiles.versatiles.org/tiles/satellite/{z}/{x}/{y}",
        // 512 px, measured from a fetched tile rather than assumed: at the default
        // 256 Cesium would request four tiles where one will do and still resolve
        // each of them at half the detail it holds.
        tileWidth: 512,
        tileHeight: 512,
        maximumLevel: 19,
        credit: `<a href="https://versatiles.org/sources/" target="_blank">VersaTiles sources</a>`,
      }),
    alpha: 1,
    base: true,
  },
  OSM: {
    create: () =>
      new OpenStreetMapImageryProvider({
        url: "https://a.tile.openstreetmap.org/",
      }),
    alpha: 1,
    base: true,
  },
  BlackMarble: {
    create: () =>
      new WebMapServiceImageryProvider({
        url: "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi",
        layers: "VIIRS_Black_Marble",
        parameters: {
          format: "image/png",
        },
        tileWidth: 512,
        tileHeight: 512,
        credit: "NASA Global Imagery Browse Services for EOSDIS",
      }),
    alpha: 1,
    base: true,
  },
  // The day's true colour as VIIRS imaged it, daily since 2015. A composite of
  // swaths, so the gaps between them near the equator are black.
  VIIRS: {
    create: (context) => createGibsTimeLayer({ layer: "VIIRS_SNPP_CorrectedReflectance_TrueColor", maximumLevel: 9, format: "jpeg", daily: true }, context),
    alpha: 1,
    base: true,
  },
  Tiles: {
    create: () => new TileCoordinatesImageryProvider(),
    alpha: 1,
    base: false,
  },
  // GOES-East's clean infrared band at the simulation time, every 10 minutes for
  // the last few months; the full disk over the Americas.
  "GOES-IR": {
    create: (context) => createGibsTimeLayer({ layer: "GOES-East_ABI_Band13_Clean_Infrared", maximumLevel: 6, format: "png", daily: false }, context),
    alpha: 0.5,
    base: false,
  },
  Nextrad: {
    create: () =>
      new WebMapServiceImageryProvider({
        url: "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi?",
        layers: "nexrad-n0r",
        credit: "US Radar data courtesy Iowa Environmental Mesonet",
        parameters: {
          transparent: "true",
          format: "image/png",
        },
      }),
    alpha: 0.5,
    base: false,
  },
};

export const terrainProviders: Record<string, TerrainProviderEntry> = {
  None: {
    create: () => new EllipsoidTerrainProvider(),
  },
  // The terrain OSM Buildings was authored against, which is why selecting that
  // surface model forces this one — see src/config/surfaceModels.ts. Needs the
  // ion token, so it is the one terrain that can fail for a reason other than
  // the network.
  CesiumWorldTerrain: {
    // Vertex normals because `globe.enableLighting` is on: without them the
    // terrain is shaded off the ellipsoid normal and the relief goes flat.
    create: () => createWorldTerrainAsync({ requestVertexNormals: true }),
  },
  // Free and keyless, which is the point of it. Best-effort uptime and no SLA, so
  // it is offered beside the two hosted options rather than instead of them.
  //
  // The `ellipsoid` variant, matching every other terrain here: Cesium wants
  // heights above the ellipsoid, and the geoid variant would sit tens of metres
  // out. The water mask is advertised but not requested — it would oblige a second
  // attribution line ("Protomaps · © OpenStreetMap contributors") for an effect on
  // the oceans that this app never looks at.
  ReEarth: {
    create: () =>
      CesiumTerrainProvider.fromUrl("https://terrain.reearth.land/cesium-mesh/ellipsoid", {
        credit: '<a href="https://terrain.reearth.land/" target="_blank">Re:Earth Terrain</a> · Mapterhorn (CC BY 4.0)',
        requestVertexNormals: true,
      }),
  },
  Maptiler: {
    create: () =>
      CesiumTerrainProvider.fromUrl("https://api.maptiler.com/tiles/terrain-quantized-mesh/?key=tiHE8Ed08u6ZoFjbE32Z", {
        credit:
          '<a href="https://www.maptiler.com/copyright/" target="_blank">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>',
        requestVertexNormals: true,
      }),
  },
  ArcGIS: {
    create: () => ArcGISTiledElevationTerrainProvider.fromUrl("https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer"),
    visible: false,
  },
};

// Name accessors, so the url schema and CesiumController share one source of
// truth for what is selectable instead of restating the list.

export function imageryProviderNames(): string[] {
  return Object.keys(imageryProviders);
}

export function baseLayerNames(): string[] {
  return Object.entries(imageryProviders)
    .filter(([, entry]) => entry.base)
    .map(([name]) => name);
}

export function overlayLayerNames(): string[] {
  return Object.entries(imageryProviders)
    .filter(([, entry]) => !entry.base)
    .map(([name]) => name);
}

/** Terrain providers a user may select. `ArcGIS` is registered but hidden. */
export function terrainProviderNames(): string[] {
  return Object.entries(terrainProviders)
    .filter(([, entry]) => entry.visible ?? true)
    .map(([name]) => name);
}
