import type { Viewer } from "@cesium/widgets";

import { CesiumCallbackHelper } from "./CesiumCallbackHelper";

// Cesium keeps a label's glyph billboards after the label is gone. `EntityCluster`
// parks a removed label's slot with `text = ""`, and unbinding pushes each glyph
// billboard onto `_spareBillboards` without removing it from
// `_glyphBillboardCollection`, which then updates every glyph the scene ever drew.
//
// Measured: going from 5,000 labelled satellites to 74 left 67,952 spares in a
// collection of 68,703 and a 250 ms frame; draining brought it back to 8.4 ms.
//
// Upstream: https://github.com/CesiumGS/cesium/issues/7184

/** Draining rebuilds the glyph collection's vertex arrays, so a few spares are left alone. */
const SPARE_BILLBOARD_THRESHOLD = 100;

/** The entity cluster's label collection sits three levels down. */
const MAX_DEPTH = 8;

/**
 * Private and unstable across versions, so `drain` reports a missing field rather
 * than skipping it: a rename once turned it into a silent no-op.
 */
interface LabelCollectionInternals {
  _labels: unknown[];
  _spareBillboards?: unknown[];
  _glyphBillboardCollection?: { remove(billboard: unknown): boolean };
}

interface PrimitiveNode {
  _primitives?: unknown[];
  _labelCollection?: unknown;
  _labels?: unknown[];
}

/** Walked rather than indexed, so it survives re-nesting and finds every data source's collection. */
export function collectLabelCollections(node: unknown, found: LabelCollectionInternals[] = [], depth = 0): LabelCollectionInternals[] {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) {
    return found;
  }
  const candidate = node as PrimitiveNode;
  if (Array.isArray(candidate._labels)) {
    found.push(candidate as LabelCollectionInternals);
  }
  if (candidate._labelCollection) {
    collectLabelCollections(candidate._labelCollection, found, depth + 1);
  }
  if (Array.isArray(candidate._primitives)) {
    for (const child of candidate._primitives) {
      collectLabelCollections(child, found, depth + 1);
    }
  }
  return found;
}

export class CesiumCleanupHelper {
  /** Report once, not on every reconcile. */
  static #reported = false;

  /**
   * Deferred: labels are unbound in the next `LabelCollection.update`, so the pool is
   * empty until a frame has passed. Below the threshold it does nothing.
   */
  static cleanup(viewer: Viewer): void {
    const stop = CesiumCallbackHelper.createPeriodicTickCallback(viewer, 1, () => {
      stop();
      CesiumCleanupHelper.drain(viewer);
    });
  }

  /** Without the tick deferral, for the unit test. */
  static drain(viewer: Viewer): number {
    const collections = collectLabelCollections(viewer.scene.primitives);
    if (collections.length === 0) {
      // Not a rename: `EntityCluster` creates its label collection on the first
      // label, so a points-only scene has none.
      return 0;
    }

    let removed = 0;
    for (const collection of collections) {
      const spares = collection._spareBillboards;
      const billboards = collection._glyphBillboardCollection;
      if (!spares || !billboards) {
        CesiumCleanupHelper.#report("LabelCollection has no _spareBillboards / _glyphBillboardCollection");
        continue;
      }
      if (spares.length < SPARE_BILLBOARD_THRESHOLD) {
        continue;
      }
      // Removing destroys the billboard, so the pool must be emptied too: a destroyed
      // billboard handed to a new glyph is worse than the leak.
      spares.forEach((billboard) => billboards.remove(billboard));
      removed += spares.length;
      spares.length = 0;
    }

    if (removed > 0) {
      console.info(`Removed ${removed} leftover Cesium glyph billboards`);
      viewer.scene.requestRender();
    }
    return removed;
  }

  /** Loud: a renamed internal makes the drain a no-op whose only symptom is a slower app. */
  static #report(problem: string): void {
    if (CesiumCleanupHelper.#reported) {
      return;
    }
    CesiumCleanupHelper.#reported = true;
    console.error(`Cannot drain leftover Cesium glyph billboards: ${problem}. Cesium internals have moved — see CesiumCleanupHelper.`);
  }

  /** Test seam for the once-only report. */
  static resetReported(): void {
    CesiumCleanupHelper.#reported = false;
  }
}
