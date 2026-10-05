import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CesiumCleanupHelper, collectLabelCollections } from "./CesiumCleanupHelper";

// A Set, because the real `remove` is indexed off `_index`; a scan made this file
// quadratic at 68,000 billboards.
const billboardCollection = (count: number) => {
  const held = new Set(Array.from({ length: count }, (_, index) => ({ id: index })));
  return {
    get billboards(): { id: number }[] {
      return [...held];
    },
    remove(billboard: unknown): boolean {
      return held.delete(billboard as { id: number });
    },
  };
};

/** Nested the way Cesium nests it: the label collection three primitive collections down. */
const sceneWith = (spareCount: number, extraBillboards = 1) => {
  const glyphs = billboardCollection(spareCount + extraBillboards);
  const labelCollection = {
    _labels: Array.from({ length: 10 }, () => ({})),
    _spareBillboards: glyphs.billboards.slice(0, spareCount) as unknown[],
    _glyphBillboardCollection: glyphs,
  };
  const primitives = { _primitives: [{ _primitives: [{ _primitives: [{ _labelCollection: labelCollection }] }] }] };
  const requestRender = vi.fn();
  return { viewer: { scene: { primitives, requestRender } }, labelCollection, glyphs, requestRender };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const drain = (viewer: unknown): number => CesiumCleanupHelper.drain(viewer as any);

describe("collectLabelCollections", () => {
  test("finds the collection wherever it is nested", () => {
    const { viewer, labelCollection } = sceneWith(200);
    expect(collectLabelCollections(viewer.scene.primitives)).toEqual([labelCollection]);
  });

  test("finds one per data source", () => {
    const first = sceneWith(200).labelCollection;
    const second = sceneWith(200).labelCollection;
    const primitives = { _primitives: [{ _labelCollection: first }, { _primitives: [{ _labelCollection: second }] }] };
    expect(collectLabelCollections(primitives)).toHaveLength(2);
  });

  test("survives a tree with no label collection at all", () => {
    expect(collectLabelCollections({ _primitives: [{}, { _primitives: [] }] })).toEqual([]);
    expect(collectLabelCollections(undefined)).toEqual([]);
  });
});

describe("CesiumCleanupHelper.drain", () => {
  beforeEach(() => {
    CesiumCleanupHelper.resetReported();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("takes the spare billboards out of the glyph collection and empties the pool", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { viewer, labelCollection, glyphs, requestRender } = sceneWith(67_952);

    expect(drain(viewer)).toBe(67_952);

    expect(labelCollection._spareBillboards).toHaveLength(0);
    // The billboard still bound to a live glyph stays.
    expect(glyphs.billboards).toHaveLength(1);
    expect(requestRender).toHaveBeenCalled();
  });

  test("leaves a small pool alone rather than rebuilding vertex arrays for it", () => {
    const { viewer, labelCollection, glyphs, requestRender } = sceneWith(99);

    expect(drain(viewer)).toBe(0);
    expect(labelCollection._spareBillboards).toHaveLength(99);
    expect(glyphs.billboards).toHaveLength(100);
    expect(requestRender).not.toHaveBeenCalled();
  });

  test("the pooled labels themselves are left in place", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { viewer, labelCollection } = sceneWith(200);

    drain(viewer);

    // Cesium reuses the slots and they measured as free, so this is not a removeAll.
    expect(labelCollection._labels).toHaveLength(10);
  });

  test("reports a renamed internal instead of skipping quietly", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { viewer, labelCollection } = sceneWith(200);
    delete (labelCollection as { _glyphBillboardCollection?: unknown })._glyphBillboardCollection;

    expect(drain(viewer)).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain("_glyphBillboardCollection");
  });

  test("a primitive tree with no label collection is silent, not reported", () => {
    // A points-only scene has no label collection; only an unreadable one is reported.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(drain({ scene: { primitives: { _primitives: [] }, requestRender: vi.fn() } })).toBe(0);

    expect(error).not.toHaveBeenCalled();
  });

  test("a broken assumption is reported once, not once per reconcile", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { viewer, labelCollection } = sceneWith(200);
    delete (labelCollection as { _spareBillboards?: unknown })._spareBillboards;

    drain(viewer);
    drain(viewer);
    drain(viewer);

    expect(error).toHaveBeenCalledTimes(1);
  });
});
