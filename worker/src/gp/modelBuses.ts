// The bus half of the model manifests (ADR 0007), apart from generate-groups.mjs so
// the worker tests reach it.

/** One model's claim on one GCAT bus, and where it was made, for the error. */
export interface BusClaim {
  bus: string;
  modelFile: string;
  origin: string;
}

/**
 * Spelled as parseGcatCatalog leaves GCAT's text: trimmed, single spaces. Anything else
 * never matches a record, and its satellites would silently stay points.
 */
export function isGcatBusName(bus: unknown): bus is string {
  return typeof bus === "string" && bus !== "" && bus === bus.trim().replace(/\s+/g, " ");
}

/**
 * GCAT bus -> modelFile, from every manifest. A bus is matched exactly and belongs to one
 * model; two models naming it is a build failure that names both, as two claims on one
 * NORAD id are.
 */
export function modelsByBus(claims: readonly BusClaim[]): Record<string, string> {
  const byBus = new Map<string, BusClaim>();
  for (const claim of claims) {
    const previous = byBus.get(claim.bus);
    if (previous !== undefined && previous.modelFile !== claim.modelFile) {
      throw new Error(`bus ${JSON.stringify(claim.bus)} is claimed by ${previous.origin} and by ${claim.origin}`);
    }
    byBus.set(claim.bus, claim);
  }
  return Object.fromEntries([...byBus].toSorted(([a], [b]) => a.localeCompare(b)).map(([bus, { modelFile }]) => [bus, modelFile]));
}
