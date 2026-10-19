import { describe, expect, test } from "vitest";

import { activeTargetEntries, buildOrder, hideFromActivation, isEnabledByTag, toggledGroup, toggledSatellite } from "./satelliteActivation";
import { CatalogEntry } from "./SatelliteCatalog";
import type { GpRecord } from "./util/gp";

/** Minimal CatalogEntry factory — activeTargetEntries only reads key/name/tags. */
function entry(name: string, satnum: string, tags: string[]): CatalogEntry {
  const record: GpRecord = { kind: "tle", name, line1: "", line2: "" };
  return new CatalogEntry({ key: `${satnum}|${name}`, name, nameUpper: name.toUpperCase(), satnum, tags, record });
}

const ALPHA = entry("ALPHA", "1", ["Weather", "New"]);
const BETA = entry("BETA", "2", ["Weather"]);
const GAMMA = entry("GAMMA", "3", ["Science"]);
const DELTA = entry("DELTA", "4", []);
const ALL = [ALPHA, BETA, GAMMA, DELTA];

const catalog = {
  entriesWithTag: (tag: string) => ALL.filter((e) => e.tags.includes(tag)),
  getByName: (name: string) => ALL.find((e) => e.name === name),
};

/** Lists with nothing enabled, overridden per test. */
function listsWith(overrides: { enabledTags?: string[]; enabledSatellites?: string[]; disabledSatellites?: string[] } = {}) {
  return { enabledTags: [], enabledSatellites: [], disabledSatellites: [], ...overrides };
}

function keys(target: Map<string, CatalogEntry>): string[] {
  return [...target.keys()].toSorted();
}

describe("activeTargetEntries", () => {
  test("empty state selects nothing", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: [], enabledSatellites: [] });
    expect(target.size).toBe(0);
  });

  test("selects by tag (OR across an entry's tags)", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: [] });
    expect(keys(target)).toEqual([ALPHA.key, BETA.key]);
  });

  test("selects by name", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: [], enabledSatellites: ["GAMMA", "DELTA"] });
    expect(keys(target)).toEqual([GAMMA.key, DELTA.key].toSorted());
  });

  test("unions tag and name selections", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Science"], enabledSatellites: ["ALPHA"] });
    expect(keys(target)).toEqual([ALPHA.key, GAMMA.key].toSorted());
  });

  test("dedups a satellite enabled by both tag and name", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: ["ALPHA"] });
    expect(keys(target)).toEqual([ALPHA.key, BETA.key]);
    expect(target.get(ALPHA.key)).toBe(ALPHA);
  });

  test("tracked satellite is kept alive even when its tag is disabled", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: [], enabledSatellites: [], trackedName: "GAMMA" });
    expect(keys(target)).toEqual([GAMMA.key]);
  });

  test("pending-tracked satellite is included", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: [], enabledSatellites: [], pendingTrackedName: "DELTA" });
    expect(keys(target)).toEqual([DELTA.key]);
  });

  test("tracked union with tag selection dedups", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: [], trackedName: "ALPHA" });
    expect(keys(target)).toEqual([ALPHA.key, BETA.key]);
  });

  test("disabledSatellites opts a member out of tag activation", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: [], disabledSatellites: ["BETA"] });
    expect(keys(target)).toEqual([ALPHA.key]);
  });

  test("disabledSatellites does not beat an explicit individual enable", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: ["BETA"], disabledSatellites: ["BETA"] });
    expect(keys(target)).toEqual([ALPHA.key, BETA.key]);
  });

  test("disabledSatellites does not beat tracking", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Weather"], enabledSatellites: [], disabledSatellites: ["BETA"], trackedName: "BETA" });
    expect(keys(target)).toEqual([ALPHA.key, BETA.key]);
  });

  test("disabledSatellites without a covering tag has no effect", () => {
    const target = activeTargetEntries({ entries: ALL, enabledTags: ["Science"], enabledSatellites: [], disabledSatellites: ["ALPHA"] });
    expect(keys(target)).toEqual([GAMMA.key]);
  });
});

describe("isEnabledByTag", () => {
  test("matches when any of the entry's tags is enabled", () => {
    expect(isEnabledByTag(ALPHA, new Set(["New"]))).toBe(true);
    expect(isEnabledByTag(ALPHA, new Set(["Science", "Weather"]))).toBe(true);
  });

  test("does not match when no tag is enabled", () => {
    expect(isEnabledByTag(GAMMA, new Set(["Weather"]))).toBe(false);
    expect(isEnabledByTag(ALPHA, new Set())).toBe(false);
  });

  test("never matches an entry without tags", () => {
    expect(isEnabledByTag(DELTA, new Set(["Weather", "Science", "New"]))).toBe(false);
  });
});

describe("hideFromActivation", () => {
  test("drops a group whose every member is hidden, leaving no exclusions behind", () => {
    const lists = { enabledTags: ["Weather", "Science"], enabledSatellites: [], disabledSatellites: [] };
    expect(hideFromActivation(lists, new Set(["ALPHA", "BETA"]), catalog)).toEqual({ enabledTags: ["Science"], enabledSatellites: [], disabledSatellites: [] });
  });

  test("excludes what a remaining group still covers", () => {
    const lists = { enabledTags: ["Weather"], enabledSatellites: [], disabledSatellites: [] };
    expect(hideFromActivation(lists, new Set(["BETA"]), catalog)).toEqual({ enabledTags: ["Weather"], enabledSatellites: [], disabledSatellites: ["BETA"] });
  });

  test("drops hidden names from sats=, and every exclusion once no group is left", () => {
    const lists = { enabledTags: ["Science"], enabledSatellites: ["DELTA", "ALPHA"], disabledSatellites: ["OLD"] };
    expect(hideFromActivation(lists, new Set(["GAMMA", "DELTA"]), catalog)).toEqual({ enabledTags: [], enabledSatellites: ["ALPHA"], disabledSatellites: [] });
  });
});

describe("toggledGroup", () => {
  test("turns an off group on", () => {
    expect(toggledGroup(listsWith(), "Weather", catalog)).toEqual({ enabledTags: ["Weather"] });
  });

  test("turns a partly excluded group full, keeping other groups' exclusions", () => {
    expect(toggledGroup(listsWith({ enabledTags: ["Weather", "Science"], disabledSatellites: ["BETA", "GAMMA"] }), "Weather", catalog)).toEqual({ disabledSatellites: ["GAMMA"] });
  });

  test("turns a full group off and drops the exclusions no group covers any more", () => {
    // BETA is only in Weather, which is off: a stale exclusion. OLD is unknown, so kept.
    expect(toggledGroup(listsWith({ enabledTags: ["New", "Science"], disabledSatellites: ["BETA", "OLD"] }), "Science", catalog)).toEqual({
      enabledTags: ["New"],
      disabledSatellites: ["OLD"],
    });
  });

  test("never writes enabledSatellites", () => {
    expect(toggledGroup(listsWith({ enabledTags: ["Weather"], enabledSatellites: ["ALPHA"] }), "Weather", catalog)).not.toHaveProperty("enabledSatellites");
  });
});

describe("toggledSatellite", () => {
  test("excludes a member of an enabled group, dropping its redundant enable", () => {
    expect(toggledSatellite(listsWith({ enabledTags: ["Weather"], enabledSatellites: ["BETA"] }), "BETA", catalog)).toEqual({
      disabledSatellites: ["BETA"],
      enabledSatellites: [],
    });
  });

  test("brings an excluded member back", () => {
    expect(toggledSatellite(listsWith({ enabledTags: ["Weather"], disabledSatellites: ["BETA"] }), "BETA", catalog)).toEqual({ disabledSatellites: [] });
  });

  test("enables a satellite outside the enabled groups, clearing a stale exclusion", () => {
    expect(toggledSatellite(listsWith({ disabledSatellites: ["GAMMA"] }), "GAMMA", catalog)).toEqual({ enabledSatellites: ["GAMMA"], disabledSatellites: [] });
  });

  test("disables an individually enabled satellite", () => {
    expect(toggledSatellite(listsWith({ enabledSatellites: ["GAMMA"] }), "GAMMA", catalog)).toEqual({ enabledSatellites: [] });
  });
});

describe("buildOrder", () => {
  const entries = (): [string, CatalogEntry][] => [
    ["a", ALPHA],
    ["b", BETA],
    ["g", GAMMA],
    ["d", DELTA],
  ];

  test("moves the tracked satellite to the front", () => {
    expect(buildOrder(entries(), GAMMA.name).map(([key]) => key)).toEqual(["g", "a", "b", "d"]);
  });

  test("keeps the order when the tracked satellite is already first", () => {
    expect(buildOrder(entries(), ALPHA.name).map(([key]) => key)).toEqual(["a", "b", "g", "d"]);
  });

  test("keeps the order when nothing is tracked or the name is not in the target", () => {
    expect(buildOrder(entries()).map(([key]) => key)).toEqual(["a", "b", "g", "d"]);
    expect(buildOrder(entries(), "NOT IN THE CATALOG").map(([key]) => key)).toEqual(["a", "b", "g", "d"]);
  });

  test("loses nothing and duplicates nothing", () => {
    const ordered = buildOrder(entries(), DELTA.name);
    expect(ordered).toHaveLength(4);
    expect(new Set(ordered.map(([key]) => key))).toEqual(new Set(["a", "b", "g", "d"]));
  });
});
