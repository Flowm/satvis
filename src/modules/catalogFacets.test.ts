import { describe, expect, test } from "vitest";

import type { SatelliteMetadata } from "../config/satelliteMetadata";
import {
  type CatalogFilter,
  type CatalogRow,
  catalogRows,
  constellationOf,
  crossfilter,
  FACET_BY_KEY,
  facetBranches,
  facetItems,
  filterChips,
  leavesByParent,
  NO_PROGRAM,
  parseOrbitLeaf,
  pickedFirst,
  UNKNOWN,
} from "./catalogFacets";
import { SatelliteCatalog } from "./SatelliteCatalog";
import type { GpRecord } from "./util/gp";

const NOW = Date.UTC(2026, 9, 18);

function record(name: string, satnum: number, elements: { meanMotion?: number; inclination?: number; epoch?: string }, metadata: SatelliteMetadata = {}): GpRecord {
  return {
    kind: "omm",
    omm: {
      OBJECT_NAME: name,
      OBJECT_ID: "",
      EPOCH: elements.epoch ?? "2026-10-17T12:00:00.000000",
      MEAN_MOTION: elements.meanMotion ?? 15.2,
      ECCENTRICITY: 0.0002,
      INCLINATION: elements.inclination ?? 53,
      RA_OF_ASC_NODE: 0,
      ARG_OF_PERICENTER: 0,
      MEAN_ANOMALY: 0,
      NORAD_CAT_ID: satnum,
      ELEMENT_SET_NO: 0,
      BSTAR: 0,
      MEAN_MOTION_DOT: 0,
      MEAN_MOTION_DDOT: 0,
    },
    metadata: { orbitClass: (elements.meanMotion ?? 15.2) > 11.25 ? "LEO" : "GEO", ...metadata },
  };
}

/** Four LEO satellites (two Starlink shells, an SSO imager, one GCAT lacks) and a GEO. */
function rows(): CatalogRow[] {
  const catalog = new SatelliteCatalog();
  catalog.addRecords(
    [
      record("STARLINK-1", 1, { inclination: 53 }, { opOrbit: "LLEO/I", program: "Starlink 2MO S1", category: "COM", country: "USA", launchDate: "2024-03-01", massKg: 800 }),
      record("STARLINK-2", 2, { inclination: 43 }, { opOrbit: "LLEO/I", program: "Starlink 2M S2", category: "COM", country: "USA", launchDate: "2025-06-01", massKg: 800 }),
      record(
        "IMAGER",
        3,
        { inclination: 97.4, epoch: "2026-09-01T00:00:00.000000" },
        { opOrbit: "LEO/S", program: "Sentinel", category: "IMG", country: "ESA", launchDate: "2019-01-01", massKg: 1200 },
      ),
      record("NEWBIE", 4, { inclination: 97.6 }, {}),
    ],
    ["Active"],
  );
  catalog.addRecords(
    [record("GEOSAT", 5, { meanMotion: 1.0027, inclination: 0.05 }, { opOrbit: "GEO/S", category: "COM", country: "USA", launchDate: "2019-05-01" })],
    ["Active", "GEO"],
  );
  return catalogRows(catalog.entries, new Set(), NOW);
}

function filter(patch: Partial<CatalogFilter> = {}): CatalogFilter {
  return { facets: {}, launchYears: null, shape: null, query: "", activeOnly: false, ...patch };
}

describe("catalogRows", () => {
  test("labels the facets, leaving gaps as Unknown", () => {
    const [starlink, , imager, newbie] = rows();
    expect(starlink).toMatchObject({ orbitKind: "I", orbitKindComputed: false, program: "Starlink 2MO S1", purposes: ["Communications"], size: "Medium, 500 kg–1 t" });
    // Its element set is 47 days old.
    expect(imager).toMatchObject({ orbitKind: "S", size: "Large, 1–5 t", elementSetAge: "1–3 months" });
    expect(newbie).toMatchObject({ orbitKind: "S", orbitKindComputed: true, program: NO_PROGRAM, country: UNKNOWN, size: UNKNOWN, elementSetAge: "Under 1 day" });
  });

  test("lists a satellite once per satnum, its groups united, a search-only group's name second", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([record("ALIAS", 7, {})], ["SearchOnly"]);
    catalog.addRecords([record("REAL NAME", 7, {})], ["Weather"]);
    const [row, ...rest] = catalogRows(catalog.entries, new Set(["SearchOnly"]), NOW);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ name: "REAL NAME", groups: ["Weather"] });
  });

  test("measures altitude from the semi-major axis", () => {
    const [starlink, , , , geo] = rows();
    expect(starlink!.altitudeKm).toBeGreaterThan(450);
    expect(starlink!.altitudeKm).toBeLessThan(650);
    expect(geo!.altitudeKm).toBeCloseTo(35786, -2);
  });
});

describe("crossfilter", () => {
  test("counts each facet under every filter but its own", () => {
    const all = rows();
    const result = crossfilter(all, filter({ facets: { purpose: new Set(["Communications"]) } }), new Set());
    expect(result.matched.map((row) => row.name)).toEqual(["STARLINK-1", "STARLINK-2", "GEOSAT"]);
    // Purpose ignores its own pick, so Imaging stays pickable with its count.
    expect(result.counts.purpose.get("Imaging")).toBe(1);
    // Country counts only the communications satellites.
    expect(result.counts.country.get("ESA")).toBeUndefined();
    expect(result.counts.country.get("USA")).toBe(3);
  });

  test("counts a row failing two filters nowhere", () => {
    const result = crossfilter(rows(), filter({ facets: { purpose: new Set(["Imaging"]), country: new Set(["USA"]) } }), new Set());
    expect(result.matched).toEqual([]);
    // GEOSAT fails purpose only, so the purpose chart still counts it; IMAGER fails country only.
    expect(result.counts.purpose.get("Communications")).toBe(3);
    expect(result.counts.country.get("ESA")).toBe(1);
    expect(result.counts.orbit.size).toBe(0);
  });

  test("brushes launch years and the shape box as dimensions of their own", () => {
    const all = rows();
    const launched = crossfilter(all, filter({ launchYears: [2024, 2026] }), new Set());
    expect(launched.matched.map((row) => row.name)).toEqual(["STARLINK-1", "STARLINK-2"]);
    expect(launched.launches.get(2019)).toBe(2);

    const shaped = crossfilter(all, filter({ shape: { altitudeKm: [300, 2000], inclinationDeg: [95, 104] } }), new Set());
    expect(shaped.matched.map((row) => row.name)).toEqual(["IMAGER", "NEWBIE"]);
    expect(shaped.shapeRows).toHaveLength(5);
  });

  test("gates every count by the query and by what the globe shows", () => {
    const result = crossfilter(rows(), filter({ query: "star", activeOnly: true }), new Set(["STARLINK-2", "IMAGER"]));
    expect(result.matched.map((row) => row.name)).toEqual(["STARLINK-2"]);
    expect([...result.counts.country.values()]).toEqual([1]);
  });

  test("finds a satellite by its catalog number", () => {
    expect(crossfilter(rows(), filter({ query: "5" }), new Set()).matched.map((row) => row.name)).toEqual(["GEOSAT"]);
  });
});

describe("tree facets", () => {
  test("folds programmes under their constellation, and orbit kinds under their class by inclination", () => {
    const all = rows();
    const { counts } = crossfilter(all, filter(), new Set());
    const constellations = facetBranches(FACET_BY_KEY.constellation, facetItems(FACET_BY_KEY.constellation, counts.constellation, undefined));
    expect(constellations.map((branch) => [branch.parent, branch.count])).toEqual([
      ["Not in GCAT yet", 2],
      ["Starlink", 2],
      ["Sentinel", 1],
    ]);
    const orbits = facetBranches(FACET_BY_KEY.orbit, facetItems(FACET_BY_KEY.orbit, counts.orbit, undefined));
    expect(orbits.map((branch) => [branch.parent, branch.leaves.map((leaf) => leaf.value)])).toEqual([
      ["LEO", ["LEO/I", "LEO/S"]],
      ["GEO", ["GEO/S"]],
    ]);
  });

  test("names a constellation by its programme's first word", () => {
    expect(constellationOf("Starlink 2MO S1")).toBe("Starlink");
    expect(constellationOf("Flock-4")).toBe("Flock");
    expect(constellationOf("OneWeb")).toBe("OneWeb");
    expect(constellationOf(NO_PROGRAM)).toBe(NO_PROGRAM);
  });

  test("parses an orbit leaf, a kindless one too", () => {
    expect(parseOrbitLeaf("LEO/S")).toEqual({ orbitClass: "LEO", kind: "S" });
    expect(parseOrbitLeaf("GEO/")).toEqual({ orbitClass: "GEO", kind: undefined });
  });

  test("lists the picked first, then the rest up to the limit", () => {
    expect(pickedFirst(["a", "b", "c", "d"], (item) => item === "d", 2)).toEqual(["d", "a"]);
    expect(pickedFirst(["a", "b"], (item) => item !== "z", 1)).toEqual(["a", "b"]);
  });

  test("keeps a picked value at 0 so it can be unpicked", () => {
    expect(facetItems(FACET_BY_KEY.country, new Map([["USA", 3]]), new Set(["Japan"]))).toEqual([
      { value: "USA", count: 3 },
      { value: "Japan", count: 0 },
    ]);
  });
});

describe("filterChips", () => {
  test("shows a fully picked parent as one chip, a partly picked one leaf by leaf", () => {
    const all = rows();
    const leaves = { constellation: leavesByParent(FACET_BY_KEY.constellation, all), orbit: leavesByParent(FACET_BY_KEY.orbit, all) };
    const chips = filterChips(filter({ facets: { constellation: new Set(["Starlink 2MO S1", "Starlink 2M S2"]), orbit: new Set(["LEO/S"]) } }), leaves);
    expect(chips.map((chip) => `${chip.facet}: ${chip.value}`)).toEqual(["Orbit: LEO Sun-sync", "Constellation: Starlink"]);
    expect(chips[1]!.clears).toEqual({ facet: "constellation", values: ["Starlink 2MO S1", "Starlink 2M S2"] });
  });

  test("adds the ranges, the query and the globe toggle", () => {
    const chips = filterChips(filter({ launchYears: [2019, 2024], query: " iss ", activeOnly: true }), {});
    expect(chips.map((chip) => chip.value)).toEqual(["2019–2024", "iss", "On the globe"]);
  });
});
