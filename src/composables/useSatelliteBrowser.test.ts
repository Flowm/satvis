// The row model and the search state, against a catalog fed by stubbed fetches.
// The composable is Cesium-free by design: it takes the catalog as an argument
// and writes only to the Pinia store, so it runs in the node-env vitest.
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SatelliteCatalog } from "../modules/SatelliteCatalog";
import type { GpRecord } from "../modules/util/gp";
import { resetGpSource } from "../modules/util/gpSource";
import { useSatStore } from "../stores/sat";
import { useSatelliteBrowser } from "./useSatelliteBrowser";

function ommRecord(name: string, satnum: number): GpRecord {
  return {
    kind: "omm",
    omm: {
      OBJECT_NAME: name,
      OBJECT_ID: "",
      EPOCH: "2026-07-04T00:00:00.000000",
      MEAN_MOTION: 15,
      ECCENTRICITY: 0,
      INCLINATION: 51,
      RA_OF_ASC_NODE: 0,
      ARG_OF_PERICENTER: 0,
      MEAN_ANOMALY: 0,
      NORAD_CAT_ID: satnum,
      ELEMENT_SET_NO: 0,
      BSTAR: 0,
      MEAN_MOTION_DOT: 0,
      MEAN_MOTION_DDOT: 0,
    },
  };
}

function json(records: GpRecord[]): () => Response {
  const body = records.map((record) => (record as { omm: unknown }).omm);
  return () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

// Weather is a full group; active is search-only and holds Weather's one
// satellite plus one that no group offers.
function installFetch(): void {
  const routes: Record<string, () => Response> = {
    "/api/groups.json": () =>
      new Response(
        JSON.stringify({
          updated: "",
          groups: [
            { name: "weather", count: 1 },
            { name: "active", count: 2 },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    "/api/gp/weather.json": json([ommRecord("METEO-1", 1)]),
    "/api/gp/active.json": json([ommRecord("METEO-1", 1), ommRecord("SENTINEL-1", 2)]),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const route = routes[String(input)];
      return route ? route() : new Response("Not Found", { status: 404 });
    }),
  );
}

// What the app wires up in SatelliteManager: the catalog's change callback
// bumps the store revision the composable's computeds depend on.
function setup() {
  const catalog = new SatelliteCatalog();
  const satStore = useSatStore();
  catalog.onChange(() => {
    satStore.catalogRevision += 1;
  });
  catalog.registerGroups([
    ["weather", ["Weather"]],
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
    expect(browser.availableGroups.value.map((group) => group.tag)).toEqual(["Weather"]);
    expect(browser.rows.value.map((row) => row.id)).toEqual(["g:Weather"]);
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

  test("a satellite found only through search is enabled by name", async () => {
    const { browser } = setup();
    const satStore = useSatStore();
    browser.setSearchQuery("SENTINEL");
    await vi.advanceTimersByTimeAsync(200);
    browser.toggleSat("SENTINEL-1");
    expect(satStore.enabledSatellites).toEqual(["SENTINEL-1"]);
    expect(satStore.enabledTags).toEqual([]);
    expect(browser.rows.value.find((row) => row.kind === "sat" && row.name === "SENTINEL-1")).toMatchObject({ checked: true });
  });
});
