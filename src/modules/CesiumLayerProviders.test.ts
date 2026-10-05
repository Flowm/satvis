// The imagery registry: what the Map menu may offer, and what the url may name.
//
// No probe to test — the depth is a build-time constant (`__IMAGERY_MAX_LEVEL__`).
// What is worth pinning down is that exactly one offline basemap survives, since
// collapsing the pair is what removed the app's absent-imagery case.

import { describe, expect, test } from "vitest";

import { baseLayerNames, imageryProviders, overlayLayerNames } from "./CesiumLayerProviders";

describe("the NaturalEarth base map", () => {
  test("is registered as a base layer", () => {
    expect(imageryProviders.NaturalEarth?.base).toBe(true);
    expect(baseLayerNames()).toContain("NaturalEarth");
  });

  // Both are gone, and a lingering entry would put a second, strictly worse basemap
  // back on the Map menu's radios — plus reinstate a url vocabulary member that
  // ADR 0001 now documents as retired.
  test("replaced Offline and OfflineHighres, which are gone from the registry", () => {
    expect(imageryProviders.Offline).toBeUndefined();
    expect(imageryProviders.OfflineHighres).toBeUndefined();
    expect(baseLayerNames()).not.toContain("Offline");
    expect(baseLayerNames()).not.toContain("OfflineHighres");
  });

  test("is the only offline basemap — every other one needs the network", () => {
    // Named sources rather than a count, so adding a hosted layer does not fail this
    // while removing the offline one silently would.
    expect(baseLayerNames()).toEqual(["NaturalEarth", "ArcGis", "VersaTiles", "OSM", "BlackMarble", "VIIRS"]);
  });

  test("opacity-only overlays stay overlays", () => {
    expect(overlayLayerNames()).toEqual(["Tiles", "GOES-IR", "Nextrad"]);
  });
});

describe("__IMAGERY_MAX_LEVEL__", () => {
  // Injected by vite's `define`, which vitest shares — so this also proves the
  // constant reaches the module graph at all rather than being an untyped global
  // that happens to type-check.
  test("is one of the two depths the tileset can have", () => {
    expect([2, 5]).toContain(__IMAGERY_MAX_LEVEL__);
  });

  // 2 is the deepest committed level and 5 the deepest the generator builds. A value
  // above 5 would make Cesium request tiles the pyramid never contains; below 2 would
  // waste levels that ship in every checkout.
  test("never exceeds what the generator produces", () => {
    expect(__IMAGERY_MAX_LEVEL__).toBeGreaterThanOrEqual(2);
    expect(__IMAGERY_MAX_LEVEL__).toBeLessThanOrEqual(5);
  });
});
