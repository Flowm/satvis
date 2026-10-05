// Cesium-free, shared by the parser, the globe and the browser. Derived by `orbitClassOf`
// (src/modules/util/gp.ts).

/** Derived from the element set, never configured. `isLeo` (satelliteGraphics.ts) gates on the same band. */
export type OrbitClass = "LEO" | "MEO" | "GEO" | "HEO";

/**
 * CSS hex, for both the globe and the browser row. LEO is most of the catalog, so it
 * takes the panel's neutral secondary text colour; the others are colour-blind-safe
 * Okabe-Ito hues.
 */
export const ORBIT_CLASS_COLOR: Record<OrbitClass, string> = {
  LEO: "#b8c4c4",
  MEO: "#56b4e9",
  GEO: "#e69f00",
  HEO: "#cc79a7",
};
