// The catalog sheet's filters and globe actions, against a catalog fed by stubbed fetches.
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SatelliteCatalog } from "../modules/SatelliteCatalog";
import { resetGpSource } from "../modules/util/gpSource";
import { useSatStore } from "../stores/sat";
import { SHOW_CAP, useCatalogFilters } from "./useCatalogFilters";

function omm(name: string, satnum: number, metadata: Record<string, unknown> = {}, inclination = 51): Record<string, unknown> {
  return { OBJECT_NAME: name, EPOCH: "2026-07-04T00:00:00.000000", MEAN_MOTION: 15, ECCENTRICITY: 0, INCLINATION: inclination, NORAD_CAT_ID: satnum, metadata };
}

function json(body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

/** Weather: two at 51°; Swarm: SHOW_CAP + 10 at 97°, more than one show may write. */
function installFetch(): void {
  const swarm = Array.from({ length: SHOW_CAP + 10 }, (_, i) => omm(`SWARM-${i}`, 1000 + i, { category: "COM" }, 97));
  const routes: Record<string, () => Response> = {
    "/api/groups.json": json({ updated: "", groups: [] }),
    "/api/gp/weather.json": json([omm("METEO-1", 1, { category: "MET" }), omm("METEO-2", 2, { category: "MET" })]),
    "/api/gp/swarm.json": json(swarm),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => routes[String(input)]?.() ?? new Response("Not Found", { status: 404 })),
  );
}

/** Wired as SatelliteManager does it. */
async function setup() {
  const catalog = new SatelliteCatalog();
  const satStore = useSatStore();
  catalog.onChange(() => {
    satStore.catalogRevision += 1;
  });
  catalog.registerGroups([
    ["weather", ["Weather"]],
    ["swarm", ["Swarm"]],
  ]);
  const sheet = useCatalogFilters(catalog);
  await sheet.loadAll();
  return { catalog, satStore, sheet };
}

describe("useCatalogFilters", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    installFetch();
  });

  afterEach(() => {
    useCatalogFilters(new SatelliteCatalog()).clearFilters();
    vi.unstubAllGlobals();
    resetGpSource();
  });

  test("loads every group and filters by a picked facet value", async () => {
    const { sheet } = await setup();
    expect(sheet.rows.value).toHaveLength(SHOW_CAP + 12);
    sheet.toggle("purpose", "Meteorology");
    expect(sheet.matched.value.map((row) => row.name)).toEqual(["METEO-1", "METEO-2"]);
    expect(sheet.chips.value.map((chip) => chip.value)).toEqual(["Meteorology"]);
  });

  test("shows at most SHOW_CAP names, replacing what the globe showed", async () => {
    const { satStore, sheet } = await setup();
    satStore.setActivation({ enabledTags: ["Weather"] });
    sheet.toggle("purpose", "Communications");
    sheet.showOnly(sheet.matched.value);
    expect(satStore.enabledTags).toEqual([]);
    expect(satStore.enabledSatellites).toHaveLength(SHOW_CAP);
  });

  test("adds only what the globe does not show yet", async () => {
    const { satStore, sheet } = await setup();
    satStore.setActivation({ enabledTags: ["Weather"] });
    sheet.toggle("purpose", "Meteorology");
    sheet.add(sheet.matched.value);
    expect(satStore.enabledSatellites).toEqual([]);
  });

  test("hides a whole group by dropping it, not by listing its members in xsats=", async () => {
    const { satStore, sheet } = await setup();
    satStore.setActivation({ enabledTags: ["Weather", "Swarm"] });
    sheet.toggle("purpose", "Meteorology");
    sheet.hide(sheet.matched.value);
    expect(satStore.enabledTags).toEqual(["Swarm"]);
    expect(satStore.disabledSatellites).toEqual([]);
  });

  test("hides part of a group as exclusions", async () => {
    const { satStore, sheet } = await setup();
    satStore.setActivation({ enabledTags: ["Weather"] });
    sheet.query.value = "METEO-1";
    sheet.hide(sheet.matched.value);
    expect(satStore.enabledTags).toEqual(["Weather"]);
    expect(satStore.disabledSatellites).toEqual(["METEO-1"]);
  });

  test("clears the globe and every filter", async () => {
    const { satStore, sheet } = await setup();
    satStore.setActivation({ enabledTags: ["Weather"], enabledSatellites: ["SWARM-1"] });
    sheet.toggle("purpose", "Meteorology");
    sheet.launchYears.value = [2000, 2026];
    sheet.clearGlobe();
    sheet.clearFilters();
    expect(sheet.active.value.size).toBe(0);
    expect(sheet.chips.value).toEqual([]);
  });

  test("picks a tree parent's every leaf, not only those another filter leaves visible", async () => {
    const { sheet } = await setup();
    sheet.toggle("purpose", "Meteorology");
    // Only the weather satellites' kind is visible now, but LEO means every LEO kind.
    expect([...sheet.result.value.counts.orbit.keys()]).toEqual(["LEO/I"]);
    sheet.toggleParent("orbit", "LEO");
    expect([...sheet.pickedFacets.orbit].toSorted()).toEqual(["LEO/I", "LEO/S"]);
    sheet.toggle("purpose", "Meteorology");
    expect(sheet.chips.value.map((chip) => `${chip.facet} ${chip.value}`)).toEqual(["Orbit LEO"]);
    expect(sheet.matched.value).toHaveLength(SHOW_CAP + 12);
  });

  test("toggles a tree parent's leaves together", async () => {
    const { sheet } = await setup();
    sheet.toggleAll("orbit", ["LEO/I", "LEO/S"]);
    expect([...sheet.pickedFacets.orbit]).toEqual(["LEO/I", "LEO/S"]);
    sheet.toggleAll("orbit", ["LEO/I", "LEO/S"]);
    expect(sheet.pickedFacets.orbit.size).toBe(0);
  });
});
