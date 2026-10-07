// GCAT payload code tables (ADR 0008). The codes travel and labels resolve here, as
// SATCAT's do (satcatCodes.ts): small, stable vocabularies, and a lookup falls back to
// the raw code. Shortened from GCAT's own definitions:
//   https://planet4589.org/space/gcat/web/cat/pcols.html (Class, Category)
//
// This module must stay Cesium-free (node-env vitest exercises it).

/** GCAT `Category`, the general purpose of a payload. */
export const GCAT_CATEGORY: Record<string, string> = {
  AST: "Astronomy",
  BIO: "Life sciences",
  CAL: "Calibration",
  COM: "Communications",
  EDU: "Education",
  EOSCI: "Earth science",
  EW: "Missile early warning",
  GEOD: "Geodesy",
  IMG: "Imaging",
  "IMG-R": "Radar imaging",
  INF: "Infrastructure",
  MET: "Meteorology",
  "MET-RO": "Radio occultation",
  MGRAV: "Microgravity",
  MISC: "Miscellaneous",
  NAV: "Navigation",
  PLAN: "Deep space",
  RB: "Rocket body",
  RV: "Reentry vehicle",
  SCI: "Science",
  SIG: "Signals intelligence",
  SS: "Human spaceflight",
  TARG: "Target",
  TECH: "Technology",
  WEAPON: "Weapon",
};

/** GCAT `Class`, the kind of owner: one letter, or two for shared use ("BD"). */
export const GCAT_CLASS: Record<string, string> = {
  A: "Amateur or academic",
  B: "Commercial",
  C: "Civil government",
  D: "Military",
};

/**
 * "IMG/TECH" -> "Imaging / Technology". GCAT appends "?" to an uncertain category, kept,
 * and "*" to one whose orbit the US keeps secret, dropped.
 */
export function gcatCategoryLabel(code: string): string {
  return code
    .split("/")
    .map((part) => {
      // Both marks can follow one code, "?" first: "SIG?*".
      const uncertain = part.includes("?");
      const bare = part.replace(/[?*]+$/, "");
      return `${GCAT_CATEGORY[bare] ?? bare}${uncertain ? "?" : ""}`;
    })
    .join(" / ");
}

/** "BD" -> "Commercial / Military"; a letter it does not know stays a letter. */
export function gcatClassLabel(code: string): string {
  return [...code].map((letter) => GCAT_CLASS[letter] ?? letter).join(" / ");
}
