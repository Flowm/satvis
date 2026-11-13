// CEOS's waveband classes (ADR 0018) as the Instruments tab draws them: a strip of
// columns, shortest wavelength first. Cesium-free.

/** One column of the strip. */
export interface WavebandColumn {
  /** CEOS's abbreviation, or "Radar" for the column every radar band shares. */
  label: string;
  colour: string;
}

/**
 * The optical and infrared classes in wavelength order, then passive microwave, then one
 * column for CEOS's nine radar bands (P to W), which an instrument rarely has more than
 * two of and which would otherwise double the strip.
 */
export const WAVEBAND_COLUMNS: readonly WavebandColumn[] = [
  { label: "UV", colour: "#b388ff" },
  { label: "VIS", colour: "#7fd2ea" },
  // Infrared warms from yellow to crimson as the wavelength grows.
  { label: "NIR", colour: "#fff176" },
  { label: "SWIR", colour: "#ffb74d" },
  { label: "MWIR", colour: "#ff8a65" },
  { label: "TIR", colour: "#e53935" },
  { label: "FIR", colour: "#ad1457" },
  { label: "MW", colour: "#81c784" },
  { label: "Radar", colour: "#4db6ac" },
];

/** The columns `bands` fill; a class CEOS adds later fills none. */
export function wavebandColumns(bands: readonly string[]): Set<string> {
  return new Set(bands.flatMap((band) => (band.endsWith("-Band") ? ["Radar"] : WAVEBAND_COLUMNS.some((column) => column.label === band) ? [band] : [])));
}
