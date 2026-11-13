// CEOS's waveband classes (ADR 0018) in order, with the colours the Instruments tab's
// strip and the catalog's bands chart draw them in. Cesium-free.

/** One column of the strip. */
export interface WavebandColumn {
  /** CEOS's abbreviation, or "Radar" for the column every radar band shares. */
  label: string;
  colour: string;
}

/** One of CEOS's waveband classes. */
export interface Waveband {
  /** CEOS's abbreviation: "VIS", "C-Band". */
  band: string;
  /** Where the catalog's bands chart puts it. */
  region: "optical" | "thermal" | "microwave" | "radar";
  colour: string;
}

/** The colour every radar band shares. */
const RADAR_COLOUR = "#4db6ac";

/**
 * The optical and infrared classes in wavelength order, then passive microwave, then
 * CEOS's nine radar bands by frequency.
 */
export const WAVEBANDS: readonly Waveband[] = [
  { band: "UV", region: "optical", colour: "#b388ff" },
  { band: "VIS", region: "optical", colour: "#7fd2ea" },
  // Infrared warms from yellow to crimson as the wavelength grows.
  { band: "NIR", region: "optical", colour: "#fff176" },
  { band: "SWIR", region: "optical", colour: "#ffb74d" },
  { band: "MWIR", region: "thermal", colour: "#ff8a65" },
  { band: "TIR", region: "thermal", colour: "#e53935" },
  { band: "FIR", region: "thermal", colour: "#ad1457" },
  { band: "MW", region: "microwave", colour: "#81c784" },
  ...["P", "L", "S", "C", "X", "Ku", "K", "Ka", "W"].map((letter) => ({ band: `${letter}-Band`, region: "radar" as const, colour: RADAR_COLOUR })),
];

/**
 * The strip's columns: one per class but the radar bands, which share one, as an
 * instrument rarely has more than two of them and they would otherwise double the strip.
 */
export const WAVEBAND_COLUMNS: readonly WavebandColumn[] = [
  ...WAVEBANDS.filter((waveband) => waveband.region !== "radar").map(({ band, colour }) => ({ label: band, colour })),
  { label: "Radar", colour: RADAR_COLOUR },
];

/** A colour per column, where `bands` fill it; a class CEOS adds later fills none. */
export function wavebandCells(bands: readonly string[]): (string | undefined)[] {
  const filled = new Set(bands.map((band) => (band.endsWith("-Band") ? "Radar" : band)));
  return WAVEBAND_COLUMNS.map((column) => (filled.has(column.label) ? column.colour : undefined));
}
