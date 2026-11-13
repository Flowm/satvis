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
  /** "rgb" is the only one so far. */
  kind: string;
  /** ISO 8601 duration between frames: "P1D", "PT10M". */
  period?: string;
  /** ISO date of the first frame that is this satellite's. */
  start?: string;
  /** ISO date of the last frame, of a layer that stopped. */
  end?: string;
  /** ISO 8601 duration: the provider keeps frames this long and no longer. */
  window?: string;
  /** It shows other satellites too, not told apart. */
  merged?: true;
  /** The deepest level worth asking for, in 256-pixel Web Mercator tiles; with `format`, what drawing it needs. */
  maxLevel?: number;
  /** The type of its tiles: "png" or "jpeg". */
  format?: string;
}

/**
 * An imagery provider (CONTEXT.md): the service that holds the layers, and its own
 * viewer for them. Not Cesium's `ImageryProvider`, which draws a layer.
 */
export interface InstrumentImageryProvider {
  /** The viewer a link opens, as the panel names it. */
  viewer: string;
  /** The viewer's address for a layer; `{layer}` is the entry's, encoded by imageryLink. */
  link: string;
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
};

/** A layer in its provider's viewer. The colon of EUMETView's `workspace:layer` stays, as its own links write it. */
export function imageryLink(provider: InstrumentImageryProvider, layer: string, end?: string): string {
  const link = provider.link.replace("{layer}", encodeURIComponent(layer).replaceAll("%3A", ":"));
  return end !== undefined && provider.ended !== undefined ? link + provider.ended.replace("{end}", encodeURIComponent(end)) : link;
}

/** "daily", "every 10 min": the periods the manifest has. Undefined for any other. */
function cadence(period: string): string | undefined {
  if (period === "P1D") {
    return "daily";
  }
  const minutes = /^PT(\d+)M$/.exec(period);
  return minutes === null ? undefined : `every ${Number(minutes[1])} min`;
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
export interface DrawnImagery {
  /** `provider:layer`, which names it in the store and the url. */
  token: string;
  /** The service that draws it. */
  provider: DrawingProvider;
  layer: string;
  maxLevel: number;
  format: "png" | "jpeg";
  /** A GIBS layer with a frame a day, which GIBS names by its date; any other's it names to the second. */
  daily: boolean;
}

/** The imagery providers whose layers the globe draws; of the others it has the link alone. */
const DRAWING_PROVIDERS = ["gibs", "eumetview"] as const;

type DrawingProvider = (typeof DRAWING_PROVIDERS)[number];

/** `provider:layer`. A provider's name has no colon, so the first one divides them. */
function imageryToken(provider: string, layer: string): string {
  return `${provider}:${layer}`;
}

/**
 * What the globe needs to draw a record's entry, or undefined where it cannot: another
 * provider's, one without `maxLevel` and `format`, or a GIBS layer whose period does
 * not say how its frames are named.
 */
export function drawnImagery(entry: unknown): DrawnImagery | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { provider, layer, maxLevel, format, period } = entry as Record<keyof SatelliteImagery, unknown>;
  const drawing = DRAWING_PROVIDERS.find((name) => name === provider);
  if (drawing === undefined || typeof layer !== "string" || !Number.isInteger(maxLevel) || (format !== "png" && format !== "jpeg")) {
    return undefined;
  }
  const daily = period === "P1D";
  if (drawing === "gibs" && !daily && !(typeof period === "string" && period.startsWith("PT"))) {
    return undefined;
  }
  return { token: imageryToken(drawing, layer), provider: drawing, layer, maxLevel: maxLevel as number, format, daily };
}

/** What an Imagery tab card needs to ask the provider for a picture of a layer the globe can draw. */
export interface ImageryPreview extends Pick<DrawnImagery, "provider" | "layer" | "format" | "daily"> {
  /** The last frame's date, of a layer that stopped. */
  end?: string;
}

/** The point a preview is centred on, in degrees. */
export interface PreviewCentre {
  latitude: number;
  longitude: number;
}

const GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
const EUMETVIEW_WMS = "https://view.eumetsat.int/geoserver/ows";

/** Pixels; twice the card's size, for a Retina screen. */
const PREVIEW_WIDTH = 480;
const PREVIEW_HEIGHT = 270;

/**
 * A layer's latest frame, `halfWidthDeg` either side of `centre`, as one WMS picture. A
 * stopped layer shows its last frame, a daily GIBS one yesterday's, as today's is still
 * filling in. The centre stays within 50° of the equator, where a polar orbiter's
 * would show only ice and the map's edge. `now` is the wall clock.
 */
export function imageryPreviewUrl(preview: ImageryPreview, centre: PreviewCentre, halfWidthDeg: number, now: Date): string {
  const halfHeight = (halfWidthDeg * PREVIEW_HEIGHT) / PREVIEW_WIDTH;
  const latitude = Math.max(-50, Math.min(50, centre.latitude));
  const bbox = [centre.longitude - halfWidthDeg, latitude - halfHeight, centre.longitude + halfWidthDeg, latitude + halfHeight].map((value) => value.toFixed(2)).join(",");
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
  const time = preview.end ?? (preview.daily ? new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10) : undefined);
  if (time !== undefined) {
    query.set("TIME", time);
  }
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
  end?: string;
  /** When it has frames, in words (imageryDetail). */
  detail?: string;
  /** The provider's viewer, which `href` opens. */
  viewer: string;
  href: string;
  /** What the globe needs to draw it, where it can. */
  drawn?: DrawnImagery;
}

/**
 * Undefined for an entry without the fields a link needs, or of a provider this app does
 * not know: a curated row can give any shape.
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
  const period = text(rest.period);
  const end = text(rest.end);
  const detail = imageryDetail({ period, start: text(rest.start), end, window: text(rest.window), ...(rest.merged === true && { merged: true }) });
  const known = IMAGERY_PROVIDERS[provider]!;
  const drawn = drawnImagery(entry);
  return {
    instrument,
    provider,
    layer,
    label,
    ...(period !== undefined && { period }),
    ...(end !== undefined && { end }),
    ...(detail !== undefined && { detail }),
    viewer: known.viewer,
    href: imageryLink(known, layer, end),
    ...(drawn !== undefined && { drawn }),
  };
}

/** Every entry of a record's `imagery` that reads. */
export function readImageryList(imagery: unknown): ImageryEntry[] {
  return (Array.isArray(imagery) ? (imagery as unknown[]) : []).flatMap((entry) => readImagery(entry) ?? []);
}

/** One layer of one satellite the globe can draw, as the Map panel lists it. */
export interface ImageryLayer extends Pick<ImageryEntry, "instrument" | "label" | "detail"> {
  /** Satnum, provider and layer: unique in the list. */
  key: string;
  /** The satellite's name. */
  satellite: string;
  /** Its token on the globe. */
  token: string;
  group: ImageryGroup;
}

/**
 * The Map panel's groups of imagery, in its order: by the satellite's orbit class, GEO, and
 * LEO for the rest, as no MEO or HEO satellite has a layer.
 */
export const IMAGERY_GROUPS = ["geo", "leo"] as const;
/** One of IMAGERY_GROUPS. */
export type ImageryGroup = (typeof IMAGERY_GROUPS)[number];

/**
 * Every layer the records carry that the globe can draw and that has not stopped, once per
 * satellite, provider and layer, by satellite name. A viewer link alone, or a layer that
 * stopped, is the satellite's Imagery tab's to offer.
 */
export function imageryLayers(entries: readonly { name: string; satnum: string; orbitClass: OrbitClass; metadata: { imagery?: unknown } }[]): ImageryLayer[] {
  const layers = new Map<string, ImageryLayer>();
  for (const { name, satnum, orbitClass, metadata } of entries) {
    for (const entry of readImageryList(metadata.imagery)) {
      const key = `${satnum}:${entry.provider}:${entry.layer}`;
      const token = entry.drawn?.token;
      if (token === undefined || entry.end !== undefined || layers.has(key)) continue;
      layers.set(key, {
        key,
        satellite: name,
        instrument: entry.instrument,
        label: entry.label,
        detail: entry.detail,
        token,
        group: orbitClass === "GEO" ? "geo" : "leo",
      });
    }
  }
  return [...layers.values()].toSorted((a, b) => a.satellite.localeCompare(b.satellite, undefined, { numeric: true }) || a.label.localeCompare(b.label));
}
