// An equal write is not free: it fires the url sync and a history entry, or
// rebuilds an equal scene. Decoded values are always fresh, so identity is not enough.

interface Comparable {
  [key: string]: unknown;
}

/**
 * Not JSON-based: `enabledSatellites` can hold thousands of names, and this stops
 * at the first difference without allocating.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  // Before the object branch: `[]` and `{}` both have zero keys.
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((entry, index) => sameValue(entry, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => sameValue((a as Comparable)[key], (b as Comparable)[key]));
}
