import { type Clock } from "@cesium/core";
import {
  ArcGisMapServerImageryProvider,
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

/**
 * Always present (see data/imagery/.gitignore). Its depth is `__IMAGERY_MAX_LEVEL__` in vite.config.ts.
 */
const NATURAL_EARTH = "data/imagery/NaturalEarthII";

/** What a layer that follows the simulation time needs from the viewer it is added to. */
export interface ImageryContext {
  clock: Clock;
  requestRender: () => void;
  /** Aborted once the layer is removed, to stop listening to the clock. */
  signal: AbortSignal;
}

export interface ImageryProviderEntry {
  /** The Map panel's name for it; the key stays the url's and the store's (ADR 0001). */
  label: string;
  create: (context: ImageryContext) => ImageryProvider | Promise<ImageryProvider>;
  alpha: number;
  base: boolean;
}

export interface TerrainProviderEntry {
  /** The Map panel's name for it. */
  label: string;
  create: () => TerrainProvider | Promise<TerrainProvider>;
}

export const imageryProviders: Record<string, ImageryProviderEntry> = {
  /** The offline base map, and the default. */
  NaturalEarth: {
    label: "Natural Earth",
    // Overrides the manifest, which declares only the committed levels; readonly after
    // construction. Above it Cesium magnifies the deepest ready ancestor tile.
    create: () =>
      TileMapServiceImageryProvider.fromUrl(NATURAL_EARTH, {
        maximumLevel: __IMAGERY_MAX_LEVEL__,
        credit: "Imagery courtesy Natural Earth",
      }),
    alpha: 1,
    base: true,
  },
  ArcGis: {
    label: "Satellite (Esri)",
    create: () =>
      ArcGisMapServerImageryProvider.fromUrl("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer", {
        enablePickFeatures: false,
      }),
    alpha: 1,
    base: true,
  },
  /**
   * Free and keyless. Cesium cannot read TileJSON, so the template and tile size are
   * copied from https://tiles.versatiles.org/tiles/satellite/tiles.json.
   */
  VersaTiles: {
    label: "Satellite (VersaTiles)",
    create: () =>
      new UrlTemplateImageryProvider({
        // The TileJSON has no `scheme`, so `xyz` applies; `{reverseY}` would invert it.
        url: "https://tiles.versatiles.org/tiles/satellite/{z}/{x}/{y}",
        // Measured from a fetched tile; at 256 Cesium requests four tiles at half detail.
        tileWidth: 512,
        tileHeight: 512,
        maximumLevel: 19,
        credit: `<a href="https://versatiles.org/sources/" target="_blank">VersaTiles sources</a>`,
      }),
    alpha: 1,
    base: true,
  },
  OSM: {
    label: "OpenStreetMap",
    create: () =>
      new OpenStreetMapImageryProvider({
        url: "https://a.tile.openstreetmap.org/",
      }),
    alpha: 1,
    base: true,
  },
  BlackMarble: {
    label: "Night (Black Marble)",
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
  /**
   * Daily true colour since 2018. A composite of swaths, so the gaps near the equator are
   * black. NOAA-20 rather than Suomi NPP, whose recent days miss more swaths.
   */
  VIIRS: {
    label: "Daily (VIIRS)",
    create: (context) => createGibsTimeLayer({ layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor", maximumLevel: 9, format: "jpeg", daily: true }, context),
    alpha: 1,
    base: true,
  },
  Tiles: {
    label: "Tile grid",
    create: () => new TileCoordinatesImageryProvider(),
    alpha: 1,
    base: false,
  },
  /** GOES-East clean infrared, every 10 minutes for the last few months, over the Americas. */
  "GOES-IR": {
    label: "Infrared (GOES-East)",
    create: (context) => createGibsTimeLayer({ layer: "GOES-East_ABI_Band13_Clean_Infrared", maximumLevel: 6, format: "png", daily: false }, context),
    alpha: 0.5,
    base: false,
  },
  Nextrad: {
    label: "US radar (NEXRAD)",
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
    label: "None",
    create: () => new EllipsoidTerrainProvider(),
  },
  /** OSM Buildings forces this terrain (src/config/surfaceModels.ts). Needs the ion token. */
  CesiumWorldTerrain: {
    label: "Cesium World Terrain",
    // `globe.enableLighting` needs vertex normals, or the relief shades flat.
    create: () => createWorldTerrainAsync({ requestVertexNormals: true }),
  },
  /**
   * Free and keyless, with no SLA. The `ellipsoid` variant, because the geoid one sits
   * tens of metres off. No water mask: it would need a second attribution line.
   */
  ReEarth: {
    label: "Re:Earth",
    create: () =>
      CesiumTerrainProvider.fromUrl("https://terrain.reearth.land/cesium-mesh/ellipsoid", {
        credit: '<a href="https://terrain.reearth.land/" target="_blank">Re:Earth Terrain</a> · Mapterhorn (CC BY 4.0)',
        requestVertexNormals: true,
      }),
  },
  Maptiler: {
    label: "MapTiler",
    create: () =>
      CesiumTerrainProvider.fromUrl("https://api.maptiler.com/tiles/terrain-quantized-mesh/?key=tiHE8Ed08u6ZoFjbE32Z", {
        credit:
          '<a href="https://www.maptiler.com/copyright/" target="_blank">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>',
        requestVertexNormals: true,
      }),
  },
};

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

export function terrainProviderNames(): string[] {
  return Object.keys(terrainProviders);
}

/** The id where it is none of ours. */
export function imageryLabel(name: string): string {
  return imageryProviders[name]?.label ?? name;
}

/** The id where it is none of ours. */
export function terrainLabel(name: string): string {
  return terrainProviders[name]?.label ?? name;
}
