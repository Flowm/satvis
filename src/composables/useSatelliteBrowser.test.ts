// The row model and search state, against a catalog fed by stubbed fetches.
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SatelliteCatalog } from "../modules/SatelliteCatalog";
import { resetGpSource } from "../modules/util/gpSource";
import { useSatStore } from "../stores/sat";
import { useSatelliteBrowser } from "./useSatelliteBrowser";

function omm(name: string, satnum: number): Record<string, unknown> {
  return { OBJECT_NAME: name, EPOCH: "2026-07-04T00:00:00.000000", MEAN_MOTION: 15, ECCENTRICITY: 0, INCLINATION: 51, NORAD_CAT_ID: satnum };
}

function json(body: unknown): () => Response {
  return () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

// Weather is a full group; active is search-only and holds Weather's one
// satellite plus one that no group offers.
function installFetch(): void {
  const routes: Record<string, () => Response> = {
    "/api/groups.json": json({
      updated: "",
      groups: [
        { name: "weather", count: 1 },
        { name: "active", count: 2 },
      ],
    }),
    "/api/gp/weather.json": json([omm("METEO-1", 1)]),
    "/api/gp/custom.json": json([omm("SAT-B", 3)]),
    "/api/gp/active.json": json([omm("METEO-1", 1), omm("SENTINEL-1", 2), omm("SAT-A", 3)]),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const route = routes[String(input)];
      return route ? route() : new Response("Not Found", { status: 404 });
    }),
  );
}

// Wired as SatelliteManager does it.
function setup() {
  const catalog = new SatelliteCatalog();
  const satStore = useSatStore();
  catalog.onChange(() => {
    satStore.catalogRevision += 1;
  });
  catalog.registerGroups([
    ["weather", ["Weather"]],
    ["custom", ["Custom"]],
    ["active", ["Active"], { searchOnly: true }],
  ]);
  return { catalog, browser: useSatelliteBrowser(catalog) };
}

describe("useSatelliteBrowser search-only groups", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    installFetch();
  });

  afterEach(async () => {
    // Module-scoped state outlives the component; leave it as the next test expects.
    const { clearSearch } = useSatelliteBrowser(new SatelliteCatalog());
    clearSearch();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    resetGpSource();
    vi.unstubAllGlobals();
  });

  test("a search-only group gets no row and no multiselect entry", async () => {
    const { catalog, browser } = setup();
    await catalog.ensureAll();
    expect(browser.availableGroups.value.map((group) => group.tag).toSorted()).toEqual(["Custom", "Weather"]);
    expect(browser.rows.value.map((row) => row.id)).toEqual(["g:Custom", "g:Weather"]);
    expect(browser.isLoading.value).toBe(false);
  });

  test("a search finds its satellites, labelled by the groups the user can pick", async () => {
    const { browser } = setup();
    browser.setSearchQuery("-1");
    expect(browser.searchLoading.value).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(browser.searchLoading.value).toBe(false);

    const sats = browser.rows.value.filter((row) => row.kind === "sat");
    expect(sats.map((row) => row.name)).toEqual(["METEO-1", "SENTINEL-1"]);
    // METEO-1 is in Weather and Active, SENTINEL-1 only in Active.
    expect(sats.map((row) => row.groupsLabel)).toEqual(["Weather", undefined]);
    // No group row for Active, even though the query matches its name.
    browser.setSearchQuery("active");
    await vi.advanceTimersByTimeAsync(200);
    expect(browser.rows.value.filter((row) => row.kind === "group")).toEqual([]);
  });

  test("a search-only copy of a satellite a group already offers stays hidden", async () => {
    const { browser } = setup();
    // Satnum 3 is SAT-B in Custom, renamed from SAT-A in Active.
    browser.setSearchQuery("3");
    await vi.advanceTimersByTimeAsync(200);
    expect(browser.rows.value.filter((row) => row.kind === "sat").map((row) => row.name)).toEqual(["SAT-B"]);
    browser.setSearchQuery("SAT-A");
    await vi.advanceTimersByTimeAsync(200);
    expect(browser.rows.value).toEqual([]);
  });

  test("a satellite found only through search is enabled by name", async () => {
    const { browser } = setup();
    const satStore = useSatStore();
    browser.setSearchQuery("SENTINEL");
    await vi.advanceTimersByTimeAsync(200);
    browser.toggleSat("SENTINEL-1");
    expect(satStore.enabledSatellites).toEqual(["SENTINEL-1"]);
    expect(satStore.enabledTags).toEqual([]);
  });

  test("activating a satellite turns it on but never off", async () => {
    const { catalog, browser } = setup();
    const satStore = useSatStore();
    await catalog.ensureAll();
    browser.setEnabledTags(["Weather"]);
    browser.activateSat("METEO-1");
    expect(satStore.disabledSatellites).toEqual([]);
    browser.activateSat("SENTINEL-1");
    browser.activateSat("SENTINEL-1");
    expect(satStore.enabledSatellites).toEqual(["SENTINEL-1"]);
  });
});
