// Instrument imagery (ADR 0019, 0020): the layers of imagery providers that a record's
// `imagery` says show its instruments, how each becomes a link, and which of them the
// globe can draw. Nothing here is fetched. Cesium-free: node-env vitest and the parity
// generator read it.

import type { OrbitClass } from "./orbitClass";

/** Worker `SatelliteImagery` (worker/src/gp/types.ts): one layer that shows one instrument. */
export interface SatelliteImagery {
  /** The CEOS short name of the instrument it shows, one of the record's `instruments`. */
  instrument: string;
  /** A key of IMAGERY_PROVIDERS; an entry of any other is left out. */
  provider: string;
  /** The provider's own id for the layer or dataset. */
  layer: string;
  /** What the picture is: "True colour". */
  label: string;
  /** "rgb", or "outline": a `cmr` layer's granule outlines, with no picture. */
  kind: string;
  /** ISO 8601 duration between frames: "P1D", "PT10M". */
  period?: string;
  /** ISO date of the first frame that is this satellite's. */
  start?: string;
  /** ISO date of the last frame, of a layer that stopped. */
  end?: string;
  /** ISO 8601 duration: the provider keeps frames this long and no longer. */
  window?: string;
  /** It shows other satellites too, not told apart: a composite's. */
  merged?: true;
  /** The deepest level worth asking for, in 256-pixel Web Mercator tiles; with `format`, what drawing it needs. */
  maxLevel?: number;
  /** The type of its tiles, one of TILE_FORMATS. */
  format?: string;
  /** The NASA CMR collections that list its granules, the near-real-time one first: a layer of one granule a frame, or a `cmr` layer of their outlines (ADR 0023). */
  granules?: string[];
}

/**
 * An imagery provider (CONTEXT.md): the service that holds the layers, and its own
 * viewer for them. Not Cesium's `ImageryProvider`, which draws a layer.
 */
export interface InstrumentImageryProvider {
  /** The viewer a link opens, as the panel names it; absent for a provider with none, whose layers this app alone shows. */
  viewer?: string;
  /** The viewer's address for a layer; `{layer}` is the entry's, encoded by imageryLink. */
  link?: string;
  /** Appended for a layer that stopped, `{end}` its last frame's date, so the viewer opens on a day that has one. */
  ended?: string;
}

/**
 * By the name a record's entry carries. The native app reads this table through
 * web-tables.json. Each link was opened in a browser on 2026-11-11.
 */
export const IMAGERY_PROVIDERS: Readonly<Record<string, InstrumentImageryProvider>> = {
  gibs: { viewer: "NASA Worldview", link: "https://worldview.earthdata.nasa.gov/?l={layer}", ended: "&t={end}" },
  eumetview: { viewer: "EUMETView", link: "https://view.eumetsat.int/productviewer?v={layer}" },
  // The dataset opens behind the Browser's own consent dialog.
  "copernicus-browser": { viewer: "Copernicus Browser", link: "https://browser.dataspace.copernicus.eu/?themeId=DEFAULT-THEME&datasetId={layer}" },
  // The georing-mosaic project's bucket (ADR 0022).
  georing: {},
  // NASA's CMR: a satellite's granule outlines, where no provider has their pixels (ADR 0023).
  cmr: {},
};

/** A layer in its provider's viewer. The colon of EUMETView's `workspace:layer` stays, as its own links write it. */
export function imageryLink(provider: { link: string; ended?: string }, layer: string, end?: string): string {
  const link = provider.link.replace("{layer}", encodeURIComponent(layer).replaceAll("%3A", ":"));
  return end !== undefined && provider.ended !== undefined ? link + provider.ended.replace("{end}", encodeURIComponent(end)) : link;
}

/**
 * "daily", "hourly", "every 3 h", "every 10 min": the periods the manifest has, or
 * `short`, for a Map panel row, "3-hourly" and "10 min". Undefined for any other.
 */
function cadence(period: string, short = false): string | undefined {
  if (period === "P1D") {
    return "daily";
  }
  if (period === "PT1H") {
    return "hourly";
  }
  const step = /^PT(\d+)([HM])$/.exec(period);
  if (step === null) {
    return undefined;
  }
  const count = Number(step[1]);
  if (step[2] === "M") {
    return short ? `${count} min` : `every ${count} min`;
  }
  return short ? `${count}-hourly` : `every ${count} h`;
}

/**
 * When a layer has frames, in words: "daily since 2018", "every 10 min, last 90 days",
 * "daily, 2017–2022". A layer that stopped says when, not how long its frames are kept.
 * Undefined where the entry says none of it.
 */
export function imageryDetail(entry: Pick<SatelliteImagery, "period" | "start" | "end" | "window" | "merged">): string | undefined {
  const { period, start, end, window, merged } = entry;
  const days = window === undefined ? null : /^P(\d+)D$/.exec(window);
  let history: string | undefined;
  // An ended layer's window only runs out: what is left of it is not "the last 90 days".
  if (start !== undefined && end !== undefined) {
    history = start.slice(0, 4) === end.slice(0, 4) ? end.slice(0, 4) : `${start.slice(0, 4)}–${end.slice(0, 4)}`;
  } else if (end !== undefined) {
    history = `until ${end.slice(0, 4)}`;
  } else if (days !== null) {
    history = `last ${days[1]} days`;
  } else if (start !== undefined) {
    history = `since ${start.slice(0, 4)}`;
  }
  const step = period === undefined ? undefined : cadence(period);
  const when = step !== undefined && history?.startsWith("since") ? [`${step} ${history}`] : [step, history];
  const parts = [...when, merged === true ? "with other satellites" : undefined].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** A layer the globe draws, named in the url by `token` (ADR 0020). */
export type DrawnImagery = TiledImagery | OutlineImagery;

/** A layer the globe draws from a provider's tiles. */
export interface TiledImagery {
  /** `provider:layer`, which names it in the store and the url. */
  token: string;
  /** The service that draws it. */
  provider: DrawingProvider;
  layer: string;
  maxLevel: number;
  format: TileFormat;
  /** A GIBS layer with a frame a day, which GIBS names by its date; any other's it names to the second. */
  daily: boolean;
  /**
   * The CMR collections that list a GIBS layer's granules, where it has one frame a
   * granule: the globe then shows the granules behind the clock, each in its outline,
   * rather than one frame (ADR 0023).
   */
  granules?: string[];
}

/** A satellite's granules as their outlines alone, from CMR, where no provider has their pixels (ADR 0023). */
export interface OutlineImagery {
  token: string;
  provider: "cmr";
  /** CMR's short name of the collection. */
  layer: string;
  /** The CMR collections that list the granules, the near-real-time one first. */
  granules: string[];
}

/** A layer the globe draws granule by granule: a GIBS layer of one granule a frame, or a `cmr` one of their outlines. */
export type GranuleLayer = DrawnImagery & { granules: string[] };

export function isGranuleLayer(drawn: DrawnImagery | undefined): drawn is GranuleLayer {
  return drawn?.granules !== undefined;
}

/** The types of tile the drawing providers send. */
export const TILE_FORMATS = ["png", "jpeg", "webp"] as const;
/** One of TILE_FORMATS. */
export type TileFormat = (typeof TILE_FORMATS)[number];

/** The imagery providers whose layers the globe draws; of the others it has the link alone. */
const DRAWING_PROVIDERS = ["gibs", "eumetview", "georing"] as const;

type DrawingProvider = (typeof DRAWING_PROVIDERS)[number];

/** `provider:layer`. A provider's name has no colon, so the first one divides them. */
function imageryToken(provider: string, layer: string): string {
  return `${provider}:${layer}`;
}

/** An entry's CMR collections, the empty ones left out. */
function collections(granules: unknown): string[] {
  return Array.isArray(granules) ? granules.filter((name): name is string => typeof name === "string" && name !== "") : [];
}

/**
 * What the globe needs to draw a record's entry, or undefined where it cannot: another
 * provider's, one without `maxLevel` and `format`, a GIBS layer whose period does not say
 * how its frames are named, or a `cmr` one without collections.
 */
export function drawnImagery(entry: unknown): DrawnImagery | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { provider, layer, maxLevel, format, period, granules } = entry as Record<keyof SatelliteImagery, unknown>;
  if (provider === "cmr") {
    const listed = collections(granules);
    return typeof layer === "string" && listed.length > 0 ? { token: imageryToken(provider, layer), provider, layer, granules: listed } : undefined;
  }
  const drawing = DRAWING_PROVIDERS.find((name) => name === provider);
  const tiles = TILE_FORMATS.find((type) => type === format);
  if (drawing === undefined || tiles === undefined || typeof layer !== "string" || !Number.isInteger(maxLevel)) {
    return undefined;
  }
  const daily = period === "P1D";
  if (drawing === "gibs" && !daily && !(typeof period === "string" && period.startsWith("PT"))) {
    return undefined;
  }
  const listed = drawing === "gibs" && !daily ? collections(granules) : [];
  return {
    token: imageryToken(drawing, layer),
    provider: drawing,
    layer,
    maxLevel: maxLevel as number,
    format: tiles,
    daily,
    ...(listed.length > 0 && { granules: listed }),
  };
}

/** What an Imagery tab card needs to ask the provider for a picture of a layer the globe can draw. */
export interface ImageryPreview extends Pick<TiledImagery, "provider" | "layer" | "format" | "daily"> {
  /** The last frame's date, of a layer that stopped. */
  end?: string;
  /** The frame to picture where it is not the latest, as GIBS names it: a granule's start. */
  at?: string;
}

/** The point a preview is centred on, in degrees. */
export interface PreviewCentre {
  latitude: number;
  longitude: number;
}

const GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
const EUMETVIEW_WMS = "https://view.eumetsat.int/geoserver/ows";

/** Pixels; twice the card's size, for a Retina screen. */
export const PREVIEW_WIDTH = 480;
export const PREVIEW_HEIGHT = 270;

/** A preview's extent in degrees, in plate carrée, as the WMS previews are. */
export interface PreviewBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * `halfWidthDeg` either side of `centre`, at the previews' aspect. The centre stays within
 * 50° of the equator, where a polar orbiter's would show only ice and the map's edge.
 */
export function previewBounds(centre: PreviewCentre, halfWidthDeg: number): PreviewBounds {
  const halfHeight = (halfWidthDeg * PREVIEW_HEIGHT) / PREVIEW_WIDTH;
  const latitude = Math.max(-50, Math.min(50, centre.latitude));
  return { west: centre.longitude - halfWidthDeg, south: latitude - halfHeight, east: centre.longitude + halfWidthDeg, north: latitude + halfHeight };
}

/**
 * A GIBS or EUMETView layer's latest frame in `bounds`, as one WMS picture. A stopped
 * layer shows its last frame, a daily GIBS one yesterday's, as today's is still filling
 * in. `now` is the wall clock. The georing mosaic has no WMS: GeoMosaicImagery.ts makes its
 * picture.
 */
export function imageryPreviewUrl(preview: ImageryPreview, bounds: PreviewBounds, now: Date): string {
  const bbox = [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(2)).join(",");
  const query = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.1.1",
    SRS: "EPSG:4326",
    STYLES: "",
    LAYERS: preview.layer,
    WIDTH: String(PREVIEW_WIDTH),
    HEIGHT: String(PREVIEW_HEIGHT),
    BBOX: bbox,
  });
  if (preview.provider === "eumetview") {
    // Transparent, or the night side of a true colour disc comes back white.
    query.set("FORMAT", "image/png");
    query.set("TRANSPARENT", "TRUE");
    return `${EUMETVIEW_WMS}?${query}`;
  }
  query.set("FORMAT", `image/${preview.format}`);
  const time = preview.at ?? preview.end ?? (preview.daily ? new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10) : undefined);
  if (time !== undefined) {
    query.set("TIME", time);
  }
  return `${GIBS_WMS}?${query}`;
}

/**
 * A GIBS layer's frame `at` (as GIBS names it) over `bounds`, as one WMS picture `width`
 * pixels across, stretched to the bounds' shape in plate carrée. JPEG: a tenth of PNG's
 * size for a granule, black where it has no pixels.
 */
export function gibsPictureUrl(layer: string, at: string, bounds: PreviewBounds, width: number, height: number): string {
  const query = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.1.1",
    SRS: "EPSG:4326",
    STYLES: "",
    LAYERS: layer,
    WIDTH: String(width),
    HEIGHT: String(height),
    BBOX: [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(3)).join(","),
    FORMAT: "image/jpeg",
    TIME: at,
  });
  return `${GIBS_WMS}?${query}`;
}

/**
 * A record's `imagery` entry, read as the native app's `SatelliteDetails.imagery` reads it:
 * what the catalog, the Map panel and the Imagery tab each take of it.
 */
export interface ImageryEntry {
  instrument: string;
  /** A key of IMAGERY_PROVIDERS. */
  provider: string;
  layer: string;
  label: string;
  period?: string;
  start?: string;
  end?: string;
  window?: string;
  /** It shows other satellites too: a composite's, which the Map panel lists once. */
  merged?: true;
  /** When it has frames, in words (imageryDetail). */
  detail?: string;
  /** The provider's viewer, which `href` opens; both absent for a provider with none. */
  viewer?: string;
  href?: string;
  /** What the globe needs to draw it, where it can. */
  drawn?: DrawnImagery;
}

/**
 * Undefined for an entry without the fields a link needs, of a provider this app does
 * not know, or one it can neither link to nor draw: a curated row can give any shape.
 */
export function readImagery(entry: unknown): ImageryEntry | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { instrument, provider, layer, label, ...rest } = entry as Record<keyof SatelliteImagery, unknown>;
  if (typeof instrument !== "string" || typeof provider !== "string" || typeof layer !== "string" || typeof label !== "string" || !Object.hasOwn(IMAGERY_PROVIDERS, provider)) {
    return undefined;
  }
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const known = IMAGERY_PROVIDERS[provider]!;
  const drawn = drawnImagery(entry);
  if (known.link === undefined && drawn === undefined) {
    return undefined;
  }
  const dates = { period: text(rest.period), start: text(rest.start), end: text(rest.end), window: text(rest.window) };
  const merged = rest.merged === true;
  const detail = imageryDetail({ ...dates, ...(merged && { merged: true }) });
  return {
    instrument,
    provider,
    layer,
    label,
    ...(Object.fromEntries(Object.entries(dates).filter(([, value]) => value !== undefined)) as Partial<typeof dates>),
    ...(merged && { merged: true }),
    ...(detail !== undefined && { detail }),
    ...(known.link !== undefined && { viewer: known.viewer, href: imageryLink({ link: known.link, ended: known.ended }, layer, dates.end) }),
    ...(drawn !== undefined && { drawn }),
  };
}

/** Every entry of a record's `imagery` that reads. */
export function readImageryList(imagery: unknown): ImageryEntry[] {
  return (Array.isArray(imagery) ? (imagery as unknown[]) : []).flatMap((entry) => readImagery(entry) ?? []);
}

/**
 * What a picture is, short enough for a Map panel row beside the satellite and the
 * instrument: "True colour, one swath per orbit" is "True", "Natural colour and fog" is
 * "Natural + fog", "GeoColor" stays. The whole label is the row's tooltip.
 */
export function shortImageryLabel(label: string): string {
  const short = label
    .split(",")[0]!
    .replace(/\s*\bcolou?r\b/gi, "")
    .replace(/\s+and\s+/g, " + ")
    .trim();
  return short === "" ? label : short;
}

/** A composite's Map panel row stands for no one satellite: it is named by its label's qualifier, "GeoRing", or this. */
export const COMPOSITE = "Composite";

/** "Natural colour, GeoRing" is "GeoRing". */
function compositeName(label: string): string {
  const qualifier = label.split(",").slice(1).join(",").trim();
  return qualifier === "" ? COMPOSITE : qualifier[0]!.toUpperCase() + qualifier.slice(1);
}

/**
 * The Map panel's groups of imagery, in its order: by the satellite's orbit class, GEO, and
 * LEO for the rest, as no MEO or HEO satellite has a layer.
 */
export const IMAGERY_GROUPS = ["geo", "leo"] as const;
/** One of IMAGERY_GROUPS. */
export type ImageryGroup = (typeof IMAGERY_GROUPS)[number];

/** What every Map panel row has: one layer the globe can draw. */
interface ImageryLayerRow extends Pick<ImageryEntry, "label" | "detail"> {
  /** Unique in the list: satnum, provider and layer, or a composite's provider and layer. */
  key: string;
  /** Its token on the globe. */
  token: string;
  group: ImageryGroup;
  /** The label, short (shortImageryLabel). */
  product: string;
}

/** One satellite's layer, as the Map panel lists it. */
export interface SatelliteImageryLayer extends ImageryLayerRow, Pick<ImageryEntry, "instrument"> {
  kind: "satellite";
  satellite: string;
}

/** A composite, as the Map panel lists it: once, for all its satellites. */
export interface CompositeImageryLayer extends ImageryLayerRow {
  kind: "composite";
  /** Its label's qualifier, "GeoRing", or COMPOSITE. */
  name: string;
  /** Its satellites by name, sorted. */
  satellites: string[];
  /** Its cadence, short, which its row shows where another names the instrument. */
  cadence: string | undefined;
}

/** One layer the globe can draw, as the Map panel lists it. */
export type ImageryLayer = SatelliteImageryLayer | CompositeImageryLayer;

/**
 * Every layer the records carry that the globe can draw and that has not stopped, once per
 * satellite, provider and layer: the composites first, then by satellite name. A composite
 * is one layer, in its first satellite's group, which has frames from its earliest
 * satellite's start. A viewer link alone, a layer that stopped, or a granule layer, which
 * is on only for an overpass replay (ADR 0023), is the satellite's Imagery tab's to offer.
 */
export function imageryLayers(entries: readonly { name: string; satnum: string; orbitClass: OrbitClass; metadata: { imagery?: unknown } }[]): ImageryLayer[] {
  const layers = new Map<string, SatelliteImageryLayer>();
  // A composite's first entry, its satellites by satnum, as a record may be in several groups, and its earliest start.
  const composites = new Map<string, { entry: ImageryEntry; group: ImageryGroup; satellites: Map<string, string>; start?: string }>();
  for (const { name, satnum, orbitClass, metadata } of entries) {
    const group = orbitClass === "GEO" ? "geo" : "leo";
    for (const entry of readImageryList(metadata.imagery)) {
      const token = entry.drawn?.token;
      if (token === undefined || entry.end !== undefined || isGranuleLayer(entry.drawn)) continue;
      if (entry.merged) {
        const composite = composites.get(token) ?? { entry, group, satellites: new Map<string, string>() };
        composite.satellites.set(satnum, name);
        if (entry.start !== undefined && (composite.start === undefined || entry.start < composite.start)) {
          composite.start = entry.start;
        }
        composites.set(token, composite);
        continue;
      }
      const key = `${satnum}:${token}`;
      if (layers.has(key)) continue;
      const { instrument, label, detail } = entry;
      layers.set(key, { kind: "satellite", key, token, group, satellite: name, instrument, label, product: shortImageryLabel(label), detail });
    }
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const compositeLayers = [...composites].map(([token, { entry, group, satellites, start }]): CompositeImageryLayer => {
    const { label, period, window } = entry;
    return {
      kind: "composite",
      key: token,
      token,
      group,
      name: compositeName(label),
      satellites: [...satellites.values()].toSorted(byName),
      cadence: period === undefined ? undefined : cadence(period, true),
      label,
      product: shortImageryLabel(label),
      detail: imageryDetail({ period, start, window }),
    };
  });
  return [
    ...compositeLayers.toSorted((a, b) => byName(a.name, b.name) || a.label.localeCompare(b.label)),
    ...[...layers.values()].toSorted((a, b) => byName(a.satellite, b.satellite) || a.label.localeCompare(b.label)),
  ];
}
