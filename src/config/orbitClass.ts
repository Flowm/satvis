// Cesium-free, shared by the parser, the globe and the browser. Derived by `orbitClassOf`
// (src/modules/util/gp.ts).

/** Derived from the element set, never configured. `isLeo` (satelliteGraphics.ts) gates on the same band. */
export type OrbitClass = "LEO" | "MEO" | "GEO" | "HEO";

/**
 * CSS hex, for the globe, the browser row and the info panel's orbit chip. LEO is most of the catalog, so it
 * takes the panel's neutral secondary text colour; the others are colour-blind-safe
 * Okabe-Ito hues.
 */
export const ORBIT_CLASS_COLOR: Record<OrbitClass, string> = {
  LEO: "#b8c4c4",
  MEO: "#56b4e9",
  GEO: "#e69f00",
  HEO: "#cc79a7",
};

/**
 * An orbit class's kind (CONTEXT.md): `code` is GCAT's, undefined where the class has none, and
 * `source` says whether GCAT's `opOrbit` gave it or the element set did.
 */
export interface OrbitKind {
  code: string | undefined;
  source: "gcat" | "computed";
}

/** GCAT's slash families, by the class each falls under. The tree ignores LLEO's 600 km split. */
const GCAT_FAMILY: Record<string, OrbitClass> = { LLEO: "LEO", LEO: "LEO", MEO: "MEO", GEO: "GEO", HEO: "HEO" };

/** GCAT codes that are kinds of their own, under whichever class the orbit has. */
const STANDALONE_KINDS = new Set(["VHEO", "GTO", "DSO"]);

/**
 * GCAT's code wherever its family fits the derived class, else the computed one: the one
 * place the upstream and the derived kind meet (ADR 0008).
 */
export function resolveOrbitKind(opOrbit: string | undefined, orbitClass: OrbitClass, computed: () => string | undefined): OrbitKind {
  if (opOrbit !== undefined) {
    const [family = "", code] = opOrbit.split("/");
    if (STANDALONE_KINDS.has(family)) {
      return { code: family, source: "gcat" };
    }
    if (GCAT_FAMILY[family] === orbitClass) {
      return { code, source: "gcat" };
    }
  }
  return { code: computed(), source: "computed" };
}

/**
 * GCAT's kinds in GCAT's order, keyed `class/code`, or the code alone for a kind of its own
 * (planet4589.org/space/gcat/web/intro/orbits.html).
 */
export const ORBIT_KINDS: Readonly<Record<string, { label: string; hint: string }>> = {
  "LEO/E": { label: "Equatorial", hint: "Inclined under 25°" },
  "LEO/I": { label: "Intermediate", hint: "25–85°: most of Starlink, the ISS" },
  "LEO/P": { label: "Polar", hint: "85–95°" },
  "LEO/S": { label: "Sun-sync", hint: "95–104°, GCAT's sun-sync band" },
  "LEO/R": { label: "Retrograde", hint: "Over 104°" },
  "GEO/S": { label: "Stationary", hint: "Kept on station: under 3°, nearly circular" },
  "GEO/I": { label: "Inclined", hint: "Inclined 3–25°" },
  "GEO/SI": { label: "Inclined", hint: "Inclined 3–25°" },
  "GEO/T": { label: "Synchronous", hint: "Synchronous at any inclination" },
  "GEO/NS": { label: "Near-synchronous", hint: "A period of 23–25 h" },
  "GEO/D": { label: "Drifting", hint: "Drifting along the arc" },
  "GEO/ID": { label: "Inclined, drifting", hint: "Inclined and drifting" },
  "HEO/M": { label: "Molniya", hint: "12 h, 63°" },
  VHEO: { label: "Very high", hint: "A period over 25 h" },
  GTO: { label: "Geotransfer", hint: "Between LEO and GEO" },
  DSO: { label: "Deep space", hint: "Out toward the Moon" },
};

/** What each class means, for the orbit tree. */
export const ORBIT_CLASS_HINT: Readonly<Record<OrbitClass, string>> = {
  LEO: "Low Earth orbit, up to 2,000 km",
  MEO: "Medium Earth orbit, GNSS among them",
  GEO: "Geosynchronous, a period of about a day",
  HEO: "Highly elliptical",
};

/** A kind's entry, by class first, since GCAT reuses letters. */
const kindEntry = (orbitClass: OrbitClass, code: string) => ORBIT_KINDS[`${orbitClass}/${code}`] ?? ORBIT_KINDS[code];

/** A kind's name ("S" is sun-sync in LEO, stationary in GEO); falls back to the code. */
export function orbitKindLabel(orbitClass: OrbitClass, code: string): string {
  return kindEntry(orbitClass, code)?.label ?? code;
}

/** What a kind means, for the orbit tree. */
export function orbitKindHint(orbitClass: OrbitClass, code: string): string | undefined {
  return kindEntry(orbitClass, code)?.hint;
}

/** GCAT's sun-sync band stands out wherever the catalog draws an orbit. */
export const SUN_SYNC_COLOR = "#63e6be";

/** The class's colour, or the sun-sync band's. */
export function orbitColor(orbitClass: OrbitClass, code?: string): string {
  return orbitClass === "LEO" && code === "S" ? SUN_SYNC_COLOR : ORBIT_CLASS_COLOR[orbitClass];
}
