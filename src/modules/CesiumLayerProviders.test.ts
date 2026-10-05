import { describe, expect, test } from "vitest";

import { baseLayerNames, imageryProviders, overlayLayerNames } from "./CesiumLayerProviders";

describe("the NaturalEarth base map", () => {
  test("is registered as a base layer", () => {
    expect(imageryProviders.NaturalEarth?.base).toBe(true);
    expect(baseLayerNames()).toContain("NaturalEarth");
  });

  // ADR 0001 documents both url values as retired.
  test("replaced Offline and OfflineHighres, which are gone from the registry", () => {
    expect(imageryProviders.Offline).toBeUndefined();
    expect(imageryProviders.OfflineHighres).toBeUndefined();
    expect(baseLayerNames()).not.toContain("Offline");
    expect(baseLayerNames()).not.toContain("OfflineHighres");
  });

  test("is the only offline basemap — every other one needs the network", () => {
    expect(baseLayerNames()).toEqual(["NaturalEarth", "ArcGis", "VersaTiles", "OSM", "BlackMarble", "VIIRS"]);
  });

  test("opacity-only overlays stay overlays", () => {
    expect(overlayLayerNames()).toEqual(["Tiles", "GOES-IR", "Nextrad"]);
  });
});

describe("__IMAGERY_MAX_LEVEL__", () => {
  // Injected by vite's `define`, which vitest shares.
  test("is one of the two depths the tileset can have", () => {
    expect([2, 5]).toContain(__IMAGERY_MAX_LEVEL__);
  });

  // 2 is the deepest committed level and 5 the deepest the generator builds.
  test("never exceeds what the generator produces", () => {
    expect(__IMAGERY_MAX_LEVEL__).toBeGreaterThanOrEqual(2);
    expect(__IMAGERY_MAX_LEVEL__).toBeLessThanOrEqual(5);
  });
});
