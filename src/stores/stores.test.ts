// The store owns the invariants, so they are asserted here. Pinia needs no DOM.
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { useCesiumStore } from "./cesium";
import { useSatStore } from "./sat";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("setActivation", () => {
  test("omitted lists keep their current value", () => {
    const sat = useSatStore();
    sat.setActivation({ enabledTags: ["Weather"], enabledSatellites: ["ISS"], disabledSatellites: ["NOAA 19"] });
    sat.setActivation({ enabledTags: ["Weather", "Stations"] });
    expect(sat.enabledSatellites).toEqual(["ISS"]);
    expect(sat.disabledSatellites).toEqual(["NOAA 19"]);
  });

  test("drops duplicates", () => {
    const sat = useSatStore();
    sat.setActivation({ enabledTags: ["Weather", "Weather"], enabledSatellites: ["ISS", "ISS"] });
    expect(sat.enabledTags).toEqual(["Weather"]);
    expect(sat.enabledSatellites).toEqual(["ISS"]);
  });

  test("keeps the enabled and excluded lists disjoint, enable winning", () => {
    const sat = useSatStore();
    sat.setActivation({ enabledSatellites: ["ISS", "NOAA 19"], disabledSatellites: ["ISS"] });
    expect(sat.enabledSatellites).toEqual(["ISS", "NOAA 19"]);
    expect(sat.disabledSatellites).toEqual([]);
  });

  test("a caller that wants the exclusion to win passes both lists", () => {
    const sat = useSatStore();
    sat.setActivation({ enabledSatellites: ["ISS", "NOAA 19"] });
    // what toggleSat does when excluding a satellite that was individually enabled
    sat.setActivation({ disabledSatellites: ["ISS"], enabledSatellites: ["NOAA 19"] });
    expect(sat.enabledSatellites).toEqual(["NOAA 19"]);
    expect(sat.disabledSatellites).toEqual(["ISS"]);
  });

  // An equal write still fires $subscribe, which would land a history entry.
  test("committing an equal value does not replace the array", () => {
    const sat = useSatStore();
    sat.setActivation({ enabledTags: ["Weather"] });
    const before = sat.enabledTags;
    sat.setActivation({ enabledTags: ["Weather"] });
    expect(sat.enabledTags).toBe(before);
  });

  test("the guarded lists are not writable", () => {
    const sat = useSatStore();
    sat.setActivation({ enabledTags: ["Weather"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // @ts-expect-error enabledTags is read-only; setActivation is the way in
    sat.enabledTags = [];
    warn.mockRestore();
    expect(sat.enabledTags).toEqual(["Weather"]);
  });
});

describe("setGroundStations", () => {
  test("keeps a station on the equator and the prime meridian", () => {
    const sat = useSatStore();
    sat.setGroundStations([
      { lat: 0, lon: 11.5, name: "Equator" },
      { lat: 48.1, lon: 0 },
    ]);
    expect(sat.groundStations).toEqual([
      { lat: 0, lon: 11.5, name: "Equator" },
      { lat: 48.1, lon: 0 },
    ]);
  });

  // A `,` or `_` in a name would drop the station on the url round trip (`wireSafeName`).
  test("replaces characters a name cannot carry through the url", () => {
    const sat = useSatStore();
    sat.setGroundStations([
      { lat: 48.1, lon: 11.5, name: "Munich, DE" },
      { lat: 0, lon: 0, name: "a_b" },
      { lat: 1, lon: 1, name: "48.13°, 11.58°" },
    ]);
    expect(sat.groundStations).toEqual([
      { lat: 48.1, lon: 11.5, name: "Munich DE" },
      { lat: 0, lon: 0, name: "a b" },
      { lat: 1, lon: 1, name: "48.13° 11.58°" },
    ]);
  });

  test("a name that was only separators is no name at all", () => {
    const sat = useSatStore();
    sat.setGroundStations([{ lat: 48.1, lon: 11.5, name: " , _ " }]);
    expect(sat.groundStations).toEqual([{ lat: 48.1, lon: 11.5 }]);
  });

  test("drops unusable coordinates", () => {
    const sat = useSatStore();
    sat.setGroundStations([
      { lat: Number.NaN, lon: 11.5 },
      { lat: 48.1, lon: 11.5 },
    ]);
    expect(sat.groundStations).toEqual([{ lat: 48.1, lon: 11.5 }]);
  });

  // The url emits 4 dp, so the store must round to agree with it.
  test("rounds coordinates to 4 decimal places", () => {
    const sat = useSatStore();
    sat.setGroundStations([{ lat: 48.123456, lon: 11.987654, name: "P" }]);
    expect(sat.groundStations).toEqual([{ lat: 48.1235, lon: 11.9877, name: "P" }]);
  });

  test("dedupes stations that differ only below the stored precision", () => {
    const sat = useSatStore();
    sat.setGroundStations([
      { lat: 48.12341, lon: 11.5 },
      { lat: 48.12342, lon: 11.5 },
    ]);
    expect(sat.groundStations).toEqual([{ lat: 48.1234, lon: 11.5 }]);
  });

  test("dedupes identical stations", () => {
    const sat = useSatStore();
    sat.setGroundStations([
      { lat: 48.1, lon: 11.5, name: "Munich" },
      { lat: 48.1, lon: 11.5, name: "Munich" },
    ]);
    expect(sat.groundStations).toHaveLength(1);
  });

  test("committing an equal value does not replace the array", () => {
    const sat = useSatStore();
    sat.setGroundStations([{ lat: 48.1, lon: 11.5 }]);
    const before = sat.groundStations;
    sat.setGroundStations([{ lat: 48.1, lon: 11.5 }]);
    expect(sat.groundStations).toBe(before);
  });
});

describe("setLayers", () => {
  test("keeps a single base layer with its overlays", () => {
    const cesium = useCesiumStore();
    cesium.setLayers(["NaturalEarth", "Nextrad"]);
    expect(cesium.layers).toEqual(["NaturalEarth", "Nextrad"]);
  });

  test("the last base layer wins and overlays survive", () => {
    const cesium = useCesiumStore();
    cesium.setLayers(["NaturalEarth", "Nextrad", "ArcGis"]);
    expect(cesium.layers).toEqual(["Nextrad", "ArcGis"]);
  });

  test("a url naming two base layers resolves to one", () => {
    const cesium = useCesiumStore();
    cesium.setLayers(["ArcGis", "OSM"]);
    expect(cesium.layers).toEqual(["OSM"]);
  });

  test("drops unknown providers", () => {
    const cesium = useCesiumStore();
    cesium.setLayers(["ArcGis", "Bogus", "Nextrad"]);
    expect(cesium.layers).toEqual(["ArcGis", "Nextrad"]);
  });

  test("preserves the alpha suffix", () => {
    const cesium = useCesiumStore();
    cesium.setLayers(["ArcGis_0.5", "Nextrad"]);
    expect(cesium.layers).toEqual(["ArcGis_0.5", "Nextrad"]);
  });

  test("layers is not writable", () => {
    const cesium = useCesiumStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // @ts-expect-error layers is read-only; setLayers is the way in
    cesium.layers = ["ArcGis"];
    warn.mockRestore();
    expect(cesium.layers).toEqual(["NaturalEarth"]);
  });
});
