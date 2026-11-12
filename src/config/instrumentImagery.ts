// Instrument imagery (ADR 0019): the layers of imagery providers that a record's `imagery`
// says show its instruments, and how each becomes a link. Nothing here is fetched or
// drawn. Cesium-free: node-env vitest and the parity generator read it.

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
