// The lower-detail copies in the model manifests (ADR 0007), apart from generate-groups.mjs
// so the worker tests reach it.

import type { ModelLod } from "./types.ts";

/** One manifest's copies of one model file, and where they were listed, for the error. */
export interface LodClaim {
  modelFile: string;
  lods: ModelLod[];
  origin: string;
}

/** A .glb path under /data/models/, as a manifest's `file` and each copy's must be: the app prefixes it. */
export function isModelPath(file: unknown): file is string {
  return typeof file === "string" && file.endsWith(".glb") && !file.startsWith("/") && !file.includes("..");
}

/**
 * A manifest entry's `lods`, checked: each a .glb path under /data/models/ with a
 * positive maxPoints below the one before it, as the models build writes them. The
 * manifest's own `measured` is left out.
 */
export function parseModelLods(lods: unknown, where: string): ModelLod[] {
  if (lods === undefined) {
    return [];
  }
  if (!Array.isArray(lods)) {
    throw new Error(`${where}: "lods" is not a list`);
  }
  let previous = Infinity;
  return lods.map((lod: unknown, i) => {
    const { file, maxPoints } = (lod ?? {}) as { file?: unknown; maxPoints?: unknown };
    if (!isModelPath(file)) {
      throw new Error(`${where}: lods[${i}].file must be a .glb path under /data/models/ (got ${JSON.stringify(file)})`);
    }
    if (typeof maxPoints !== "number" || !(maxPoints > 0 && maxPoints < previous)) {
      throw new Error(`${where}: lods[${i}].maxPoints must be positive and below the one before it (got ${JSON.stringify(maxPoints)})`);
    }
    previous = maxPoints;
    return { file, maxPoints };
  });
}

/**
 * modelFile -> its copies, from every manifest. Two manifests giving one file different
 * copies is a build failure that names both, as two claims on one bus are.
 */
export function modelLodsByFile(claims: readonly LodClaim[]): Record<string, ModelLod[]> {
  const byFile = new Map<string, LodClaim>();
  for (const claim of claims) {
    const previous = byFile.get(claim.modelFile);
    if (previous !== undefined && JSON.stringify(previous.lods) !== JSON.stringify(claim.lods)) {
      throw new Error(`${claim.modelFile} has different lods in ${previous.origin} and in ${claim.origin}`);
    }
    byFile.set(claim.modelFile, claim);
  }
  return Object.fromEntries([...byFile].toSorted(([a], [b]) => a.localeCompare(b)).map(([file, { lods }]) => [file, lods]));
}
