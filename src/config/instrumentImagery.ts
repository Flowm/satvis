// Instrument imagery (ADR 0019, 0020): the layers of imagery providers that a record's
// `imagery` says show its instruments, how each becomes a link, and which of them the
// globe can draw. Nothing here is fetched. Cesium-free: node-env vitest and the parity
// generator read it.

import { formatDate } from "@/modules/util/formats";
import { durationMs } from "@/modules/util/timeDomain";

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
  /** The collections that list its granules, CMR's or EUMETSAT's Data Store's, the preferred one first: a layer replayed granule by granule (ADR 0023). */
  granules?: string[];
  /** The satellite's name in a collection that lists several: "LANDSAT-9", "Sentinel-3A". */
  platform?: string;
  /** A EUMETView granule layer's: how long after a granule's start the frame holding it is stamped nearest. */
  frame?: string;
  /** A `cmr` layer's pictures: the layer whose frames each granule is cut from. */
  pictures?: { provider: string; layer: string; frame: string };
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
  /** Who makes its composites, which a composite's picture line credits: "by EUMETSAT". */
  maker?: string;
}

/**
 * By the name a record's entry carries. The native app reads this table through
 * web-tables.json. Each link was opened in a browser on 2026-11-11.
 */
export const IMAGERY_PROVIDERS: Readonly<Record<string, InstrumentImageryProvider>> = {
  gibs: { viewer: "NASA Worldview", link: "https://worldview.earthdata.nasa.gov/?l={layer}", ended: "&t={end}", maker: "NASA" },
  eumetview: { viewer: "EUMETView", link: "https://view.eumetsat.int/productviewer?v={layer}", maker: "EUMETSAT" },
  // The dataset opens behind the Browser's own consent dialog.
  "copernicus-browser": {
    viewer: "Copernicus Browser",
    link: "https://browser.dataspace.copernicus.eu/?themeId=DEFAULT-THEME&datasetId={layer}",
    maker: "Copernicus",
  },
  // The georing-mosaic project's bucket (ADR 0022), which has no viewer: its source is the
  // project, ours, every layer linking to its repository.
  georing: { viewer: "satvis", link: "https://github.com/Flowm/georing-mosaic", maker: "satvis" },
  // A satellite's granules as NASA's CMR or EUMETSAT's Data Store lists them, with pictures cut from another layer's frames or outlines alone (ADR 0023).
  cmr: {},
};

/** A layer in its provider's viewer. The colon of EUMETView's `workspace:layer` stays, as its own links write it. */
export function imageryLink(provider: { link: string; ended?: string }, layer: string, end?: string): string {
  const link = provider.link.replace("{layer}", encodeURIComponent(layer).replaceAll("%3A", ":"));
  return end !== undefined && provider.ended !== undefined ? link + provider.ended.replace("{end}", encodeURIComponent(end)) : link;
}

/** "daily", "hourly", "every 3 h", "every 10 min": the periods the manifest has. Undefined for any other. */
function cadence(period: string): string | undefined {
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
    return `every ${count} min`;
  }
  return `every ${count} h`;
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
  /** The collections that list the layer's granules, where the globe draws it granule by granule (ADR 0023). */
  granules?: string[];
  /** The satellite's name in a collection that lists several. */
  platform?: string;
  /** Its own frames, as a granule layer's pictures. */
  pictures?: GranulePictures;
}

/** A satellite's granules from a catalogue, as outlines, or cut from another layer's frames (ADR 0023). */
export interface OutlineImagery {
  token: string;
  provider: "cmr";
  /** Names the layer: the collection's short name, with the satellite where it lists several. */
  layer: string;
  /** The collections that list the granules, the preferred one first. */
  granules: string[];
  platform?: string;
  /** Where its granules' pictures are cut from; absent for outlines alone. */
  pictures?: GranulePictures;
}

/** Where a granule layer's pictures come from, and how the frame holding a granule is named (ADR 0023). */
export interface GranulePictures {
  provider: "gibs" | "eumetview";
  layer: string;
  /**
   * "granule": a frame a granule, named by its start and drawn as a tile layer once passed
   * (GIBS's granule layers); "day": a frame a UTC day; or the milliseconds after a granule's
   * start that the frame holding it is stamped nearest (EUMETView's swaths and orbits).
   */
  frame: "granule" | "day" | number;
}

/**
 * A layer the globe draws granule by granule: a GIBS layer of one granule a frame, a
 * EUMETView one of a swath an orbit, each granule cut from it, or a `cmr` one of outlines,
 * with or without pictures cut from another layer.
 */
export type GranuleLayer = DrawnImagery & { granules: string[] };

/** Whether the layer is one of granules, a frame each, which follows the clock (ADR 0023). */
export function isGranuleLayer(drawn: DrawnImagery | undefined): drawn is GranuleLayer {
  return drawn?.granules !== undefined;
}

/**
 * The record whose own granule layer `token` is, with the layer and its instrument; none for
 * a composite's, which is no one satellite's, or a token of another layer.
 */
export function granuleLayerOwner<Entry extends { metadata: { imagery?: unknown } }>(
  entries: readonly Entry[],
  token: string,
): { entry: Entry; layer: GranuleLayer; instrument: string } | undefined {
  for (const entry of entries) {
    const found = readImageryList(entry.metadata.imagery).find(({ drawn, merged }) => !merged && drawn?.token === token);
    if (found !== undefined) {
      return isGranuleLayer(found.drawn) ? { entry, layer: found.drawn, instrument: found.instrument } : undefined;
    }
  }
  return undefined;
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

/** An entry's collections, the empty ones left out. */
function collections(granules: unknown): string[] {
  return Array.isArray(granules) ? granules.filter((name): name is string => typeof name === "string" && name !== "") : [];
}

/** "day", or a duration in milliseconds, of an entry's `frame`; undefined for another. */
function readFrame(frame: unknown): "day" | number | undefined {
  if (frame === "day") return "day";
  return typeof frame === "string" ? durationMs(frame) : undefined;
}

/** A `cmr` entry's `pictures`, or undefined where they do not read. */
function readPictures(pictures: unknown): GranulePictures | undefined {
  if (typeof pictures !== "object" || pictures === null) return undefined;
  const { provider, layer, frame } = pictures as Record<string, unknown>;
  const named = readFrame(frame);
  if ((provider !== "gibs" && provider !== "eumetview") || typeof layer !== "string" || named === undefined) return undefined;
  return { provider, layer, frame: named };
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
  const { provider, layer, maxLevel, format, period, granules, platform, frame, pictures } = entry as Record<keyof SatelliteImagery, unknown>;
  const named = typeof platform === "string" && platform !== "" ? { platform } : {};
  if (provider === "cmr") {
    const listed = collections(granules);
    if (typeof layer !== "string" || listed.length === 0) {
      return undefined;
    }
    const cut = readPictures(pictures);
    return { token: imageryToken(provider, layer), provider, layer, granules: listed, ...named, ...(cut !== undefined && { pictures: cut }) };
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
  // A GIBS granule layer has a frame a granule; a EUMETView one says when its frame of a granule is stamped.
  const after = drawing === "eumetview" ? readFrame(frame) : undefined;
  const own: GranulePictures | undefined =
    drawing === "gibs"
      ? { provider: drawing, layer, frame: "granule" }
      : drawing === "eumetview" && typeof after === "number"
        ? { provider: drawing, layer, frame: after }
        : undefined;
  const listed = own !== undefined && typeof period === "string" && period.startsWith("PT") ? collections(granules) : [];
  return {
    token: imageryToken(drawing, layer),
    provider: drawing,
    layer,
    maxLevel: maxLevel as number,
    format: tiles,
    daily,
    ...(listed.length > 0 && { granules: listed, ...named, pictures: own }),
  };
}

/** What an Imagery tab card needs to ask the provider for a picture of a layer the globe can draw. */
export interface ImageryPreview extends Pick<TiledImagery, "provider" | "layer" | "format" | "daily"> {
  /** The last frame's date, of a layer that stopped. */
  end?: string;
  /** A granule layer's pictures, which name the frame of `granule`. */
  pictures?: GranulePictures;
  /** The start (epoch ms) of the granule to picture, where the latest frame is not wanted. */
  granule?: number;
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
    if (preview.granule !== undefined && preview.pictures !== undefined) {
      query.set("TIME", granuleFrame(preview.pictures, preview.granule));
    }
    return `${EUMETVIEW_WMS}?${query}`;
  }
  query.set("FORMAT", `image/${preview.format}`);
  const time =
    (preview.granule !== undefined && preview.pictures !== undefined ? granuleFrame(preview.pictures, preview.granule) : undefined) ??
    preview.end ??
    (preview.daily ? new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10) : undefined);
  if (time !== undefined) {
    query.set("TIME", time);
  }
  return `${GIBS_WMS}?${query}`;
}

/** The time that names the frame of `pictures` holding the granule that starts at `start` (epoch ms). */
function granuleFrame(pictures: GranulePictures, start: number): string {
  if (pictures.frame === "day") {
    return new Date(start).toISOString().slice(0, 10);
  }
  const at = new Date(pictures.frame === "granule" ? start : start + pictures.frame).toISOString();
  return `${at.slice(0, 19)}Z`;
}

/**
 * The frame of the granule that starts at `start` (epoch ms) over `bounds`, as one WMS
 * picture `width` pixels across, stretched to the bounds' shape in plate carrée, or with
 * `srs` in that projection, the bounds in its metres. JPEG: a tenth of PNG's size for a
 * granule, on black where it has no pixels, as EUMETView's and GIBS's PNG layers would
 * otherwise answer white.
 */
export function granulePictureUrl(pictures: GranulePictures, start: number, bounds: PreviewBounds, width: number, height: number, srs = "EPSG:4326"): string {
  const query = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.1.1",
    SRS: srs,
    STYLES: "",
    LAYERS: pictures.layer,
    WIDTH: String(width),
    HEIGHT: String(height),
    BBOX: [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(3)).join(","),
    FORMAT: "image/jpeg",
    BGCOLOR: "0x000000",
    TIME: granuleFrame(pictures, start),
  });
  return `${pictures.provider === "eumetview" ? EUMETVIEW_WMS : GIBS_WMS}?${query}`;
}

/**
 * What a layer shows, named for what a user sees rather than how it is made (ADR 0024):
 * - `passes`: a granule layer, each pass drawn behind the satellite as the clock runs,
 *   hours to days behind live;
 * - `daily`: a day's passes in one picture;
 * - `orbits`: the last few orbits stacked in one picture (Metop's);
 * - `live`: a geostationary imager's picture every few minutes;
 * - `mosaic`: a composite the globe draws, several satellites' pictures in one;
 * - `scenes`: a composite only its provider's viewer shows, scene by scene.
 */
export type ImageryType = "passes" | "daily" | "orbits" | "live" | "mosaic" | "scenes";

/** A type's names, the title of its Imagery tab card and the short one of its Map panel button, and its Lucide icon. */
export const IMAGERY_TYPES: Readonly<Record<ImageryType, { title: string; short: string; icon: string }>> = {
  /** A route: the passes as they are drawn, one after another. */
  passes: { title: "Passes", short: "Passes", icon: "lucide:route" },
  /** A day's pictures, as the calendar's day. */
  daily: { title: "Daily mosaic", short: "Daily", icon: "lucide:calendar-days" },
  /** Orbits stacked as layers. */
  orbits: { title: "Latest orbits", short: "Orbits", icon: "lucide:layers" },
  /** The disc a geostationary imager sees. */
  live: { title: "Live view", short: "Live", icon: "lucide:earth" },
  /** The whole globe, as the composite covers it. */
  mosaic: { title: "World mosaic", short: "World", icon: "lucide:globe" },
  /** A stack of scenes, one picture each. */
  scenes: { title: "Scene archive", short: "Scenes", icon: "lucide:images" },
};

/**
 * An entry's type. Only Metop's stacked orbits say so in their label: the manifest gives
 * them no period, as a frame holds several.
 */
export function imageryType(entry: { label: string; period?: string; merged: boolean; drawn?: DrawnImagery }): ImageryType {
  if (entry.drawn?.granules !== undefined) return "passes";
  if (entry.merged) return entry.drawn === undefined ? "scenes" : "mosaic";
  if (/\borbits\b/i.test(entry.label)) return "orbits";
  return entry.period === "P1D" ? "daily" : "live";
}

/** A layer in words, one question a slot, the same for every layer (ADR 0024). */
export interface ImageryWords {
  /** What the picture is: its colours, then the instrument. "True colour · MODIS". */
  picture: string;
  /** How often it has a new picture, or the day it ended. "Once a day", "Every 10 min". */
  updates?: string;
  /** It has ended: `updates` says when. */
  ended: boolean;
  /** How far back its frames go: "Back to 2002", "The last 90 days", "2017–2022". */
  archive?: string;
}

/** What a type says of how often it updates, where its period does not. */
const TYPE_UPDATES: Partial<Record<ImageryType, string>> = {
  passes: "With each pass, hours behind live",
  daily: "Once a day",
  orbits: "With each orbit",
  scenes: "As new scenes come in",
};

/**
 * The words for an entry. The label's qualifier stays in the picture where it says something
 * of it ("nadir camera", "Europe"), not where the type's title says it already: Metop's "six
 * orbits stacked", a composite's "GeoRing", which the interface does not name.
 */
export function imageryWords(entry: {
  type: ImageryType;
  /** A key of IMAGERY_PROVIDERS, whose maker a composite credits. */
  provider: string;
  instrument: string;
  label: string;
  period?: string;
  start?: string;
  end?: string;
  window?: string;
  merged?: boolean;
}): ImageryWords {
  const { type, instrument, label, period, start, end, window } = entry;
  const [first = label, ...rest] = label.split(",").map((part) => part.trim());
  const colours = first.replace(/\s+and\s+/g, " + ");
  const qualifier = type === "orbits" || type === "mosaic" || type === "scenes" ? "" : rest.join(", ");
  const maker = IMAGERY_PROVIDERS[entry.provider]?.maker;
  // A composite is no one instrument's: it says who joined the satellites' pictures.
  const source = entry.merged !== true ? instrument : maker === undefined ? `${instrument} and others` : `by ${maker}`;
  const picture = `${colours}${qualifier === "" ? "" : ` (${qualifier})`} · ${source}`;
  const every = period === undefined ? undefined : cadence(period);
  const updates = end !== undefined ? `Ended ${formatDate(end)}` : (TYPE_UPDATES[type] ?? (every === undefined ? undefined : every[0]!.toUpperCase() + every.slice(1)));
  const days = window === undefined ? null : /^P(\d+)D$/.exec(window);
  const archive =
    start !== undefined && end !== undefined
      ? start.slice(0, 4) === end.slice(0, 4)
        ? end.slice(0, 4)
        : `${start.slice(0, 4)}–${end.slice(0, 4)}`
      : end !== undefined
        ? undefined
        : days !== null
          ? `The last ${days[1]} days`
          : start !== undefined
            ? `Back to ${start.slice(0, 4)}`
            : undefined;
  return { picture, ...(updates !== undefined && { updates }), ended: end !== undefined, ...(archive !== undefined && { archive }) };
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
  /** What kind of layer it is, which every place names it by (imageryType). */
  type: ImageryType;
  /** What the Imagery tab and the Map panel say of it (imageryWords). */
  words: ImageryWords;
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
  const type = imageryType({ label, period: dates.period, merged, drawn });
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
    type,
    words: imageryWords({ type, provider, instrument, label, ...dates, merged }),
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

/**
 * The Map panel's groups of imagery, in its order: by the satellite's orbit class, GEO, and
 * LEO for the rest, as no MEO or HEO satellite has a layer.
 */
export const IMAGERY_GROUPS = ["geo", "leo"] as const;
/** One of IMAGERY_GROUPS. */
export type ImageryGroup = (typeof IMAGERY_GROUPS)[number];

/** What every Map panel row has: one layer the globe can draw. */
interface ImageryLayerRow extends Pick<ImageryEntry, "label" | "type" | "words"> {
  /** Unique in the list: satnum, provider and layer, or a composite's provider and layer. */
  key: string;
  /** Its token on the globe. */
  token: string;
  group: ImageryGroup;
}

/** One satellite's layer, as the Map panel lists it. */
export interface SatelliteImageryLayer extends ImageryLayerRow, Pick<ImageryEntry, "instrument"> {
  kind: "satellite";
  satellite: string;
}

/** A composite, as the Map panel lists it: once, for all its satellites. */
export interface CompositeImageryLayer extends ImageryLayerRow {
  kind: "composite";
  /** Its satellites by name, sorted. */
  satellites: string[];
}

/** One layer the globe can draw, as the Map panel lists it. */
export type ImageryLayer = SatelliteImageryLayer | CompositeImageryLayer;

/**
 * Every layer the records carry that the globe can draw and that has not stopped, once per
 * satellite, provider and layer: the composites first, then by satellite name. A composite
 * is one layer, in its first satellite's group. A viewer link alone, or a layer that stopped, is the satellite's
 * Imagery tab's to offer.
 */
export function imageryLayers(entries: readonly { name: string; satnum: string; orbitClass: OrbitClass; metadata: { imagery?: unknown } }[]): ImageryLayer[] {
  const layers = new Map<string, SatelliteImageryLayer>();
  // A composite's first entry, and its satellites by satnum, as a record may be in several groups.
  const composites = new Map<string, { entry: ImageryEntry; group: ImageryGroup; satellites: Map<string, string> }>();
  for (const { name, satnum, orbitClass, metadata } of entries) {
    const group = orbitClass === "GEO" ? "geo" : "leo";
    for (const entry of readImageryList(metadata.imagery)) {
      const token = entry.drawn?.token;
      if (token === undefined || entry.end !== undefined) continue;
      if (entry.merged) {
        const composite = composites.get(token) ?? { entry, group, satellites: new Map<string, string>() };
        composite.satellites.set(satnum, name);
        composites.set(token, composite);
        continue;
      }
      const key = `${satnum}:${token}`;
      if (layers.has(key)) continue;
      const { instrument, label, type, words } = entry;
      layers.set(key, { kind: "satellite", key, token, group, satellite: name, instrument, label, type, words });
    }
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const compositeLayers = [...composites].map(([token, { entry, group, satellites }]): CompositeImageryLayer => ({
    kind: "composite",
    type: entry.type,
    words: entry.words,
    key: token,
    token,
    group,
    satellites: [...satellites.values()].toSorted(byName),
    label: entry.label,
  }));
  return [
    ...compositeLayers.toSorted((a, b) => a.label.localeCompare(b.label)),
    ...[...layers.values()].toSorted((a, b) => byName(a.satellite, b.satellite) || a.label.localeCompare(b.label)),
  ];
}

/** The order of a row's buttons: what shows at once first, the passes, which may not, last. */
const TYPE_ORDER: readonly ImageryType[] = ["daily", "orbits", "live", "mosaic", "scenes", "passes"];

/** A Map panel row: a satellite, or a composite, and a button for each of its layers (ADR 0024). */
export interface ImageryRow {
  /** Unique in its group: the satellite's name, or `composite:` and the type. */
  key: string;
  /** The satellite's whole name, or a composite row's type ("World mosaic"). */
  name: string;
  /** A row of composites, whose cells are CompositeImageryLayer. */
  composite?: true;
  /**
   * Each named by its type, or a composite's by its picture ("Day/Night", "Natural"). A satellite's second layer of a
   * type is `extra`, named by its instrument or, where that is the same, its colours: the
   * panel shows it only while it is on, and the satellite's Imagery tab always.
   */
  cells: { layer: ImageryLayer; name: string; extra: boolean }[];
}

/** A group's rows: its composites first, a row a type, then its satellites, in the order they come. */
export function imageryRows(layers: readonly ImageryLayer[]): ImageryRow[] {
  const rows = new Map<string, ImageryRow>();
  for (const layer of layers) {
    // A group's composites of a type are one row, named by the type: "World mosaic".
    const key = layer.kind === "composite" ? `composite:${layer.type}` : layer.satellite;
    const row = rows.get(key) ?? {
      key,
      name: layer.kind === "composite" ? IMAGERY_TYPES[layer.type].title : layer.satellite,
      ...(layer.kind === "composite" && { composite: true as const }),
      cells: [],
    };
    row.cells.push({ layer, name: "", extra: false });
    rows.set(key, row);
  }
  for (const row of rows.values()) {
    row.cells.sort((a, b) => TYPE_ORDER.indexOf(a.layer.type) - TYPE_ORDER.indexOf(b.layer.type));
    row.cells.forEach((cell, index) => {
      const { layer } = cell;
      if (layer.kind === "composite") {
        cell.name = shortImageryLabel(layer.label);
        return;
      }
      const before = row.cells.slice(0, index).flatMap(({ layer: other }) => (other.kind === "satellite" && other.type === layer.type ? [other] : []));
      cell.extra = before.length > 0;
      cell.name = !cell.extra ? IMAGERY_TYPES[layer.type].short : before.some((other) => other.instrument === layer.instrument) ? shortImageryLabel(layer.label) : layer.instrument;
    });
  }
  const all = [...rows.values()];
  return [...all.filter((row) => row.composite !== undefined), ...all.filter((row) => row.composite === undefined)];
}
