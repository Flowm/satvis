import { describe, expect, test } from "vitest";

import { orbitKindLabel, resolveOrbitKind } from "./orbitClass";

describe("resolveOrbitKind", () => {
  const computed = () => "computed-kind";

  test("takes GCAT's kind when its family fits the derived class, LLEO and LEO alike", () => {
    expect(resolveOrbitKind("LLEO/S", "LEO", computed)).toEqual({ code: "S", source: "gcat" });
    expect(resolveOrbitKind("LEO/P", "LEO", computed)).toEqual({ code: "P", source: "gcat" });
    expect(resolveOrbitKind("GEO/D", "GEO", computed)).toEqual({ code: "D", source: "gcat" });
  });

  test("keeps GCAT's word that a class has no kind, rather than computing one", () => {
    expect(resolveOrbitKind("MEO", "MEO", computed)).toEqual({ code: undefined, source: "gcat" });
    expect(resolveOrbitKind("HEO", "HEO", computed)).toEqual({ code: undefined, source: "gcat" });
  });

  test("computes the kind when GCAT has no code, or one for a class the orbit has left", () => {
    expect(resolveOrbitKind(undefined, "LEO", computed)).toEqual({ code: "computed-kind", source: "computed" });
    // A GEO satellite parked in a graveyard above, now classed MEO.
    expect(resolveOrbitKind("GEO/S", "MEO", () => undefined)).toEqual({ code: undefined, source: "computed" });
  });

  test("files a kind of its own under whichever class the orbit has", () => {
    expect(resolveOrbitKind("GTO", "HEO", computed)).toEqual({ code: "GTO", source: "gcat" });
    expect(resolveOrbitKind("VHEO", "MEO", computed)).toEqual({ code: "VHEO", source: "gcat" });
  });

  test("computes nothing when GCAT decides", () => {
    let calls = 0;
    resolveOrbitKind("LLEO/I", "LEO", () => {
      calls += 1;
      return "E";
    });
    expect(calls).toBe(0);
  });
});

describe("orbitKindLabel", () => {
  test("names a kind by its class, since GCAT reuses letters", () => {
    expect(orbitKindLabel("LEO", "S")).toBe("Sun-sync");
    expect(orbitKindLabel("GEO", "S")).toBe("Stationary");
    expect(orbitKindLabel("HEO", "GTO")).toBe("Geotransfer");
  });

  test("falls back to the code", () => {
    expect(orbitKindLabel("MEO", "X")).toBe("X");
  });
});
