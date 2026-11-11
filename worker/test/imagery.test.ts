import { describe, expect, it } from "vitest";

import { imageryBySatellite } from "../src/gp/imagery.ts";

const trueColour = { provider: "gibs", layer: "TrueColor", label: "True colour", kind: "rgb" };

const satellite = (noradId: number, instruments: unknown) => ({ noradId, instruments });

describe("imageryBySatellite", () => {
  it("gives each satellite its instruments' entries in manifest order", () => {
    const granule = { ...trueColour, layer: "TrueColor_Granule", label: "True colour, per granule", period: "PT6M", window: "P90D" };
    const imagery = imageryBySatellite(
      {
        satellites: [
          { noradId: 43013, name: "NOAA 20", instruments: { VIIRS: [{ ...trueColour, period: "P1D", start: "2018-01-05" }, granule], CERES: [{ ...trueColour, layer: "Other" }] } },
        ],
      },
      "core",
    );

    expect([...imagery]).toEqual([
      [
        43013,
        [
          { instrument: "VIIRS", ...trueColour, period: "P1D", start: "2018-01-05" },
          { instrument: "VIIRS", ...granule },
          { instrument: "CERES", ...trueColour, layer: "Other" },
        ],
      ],
    ]);
  });

  it("takes a layer under several satellites when each says it is merged", () => {
    const scenes = { provider: "copernicus-browser", layer: "CDAS_L8_L9_LOTL1", label: "True colour scenes", kind: "rgb", merged: true };
    const imagery = imageryBySatellite({ satellites: [satellite(39084, { OLI: [scenes] }), satellite(49260, { "OLI-2": [scenes] })] }, "core");

    expect(imagery.get(39084)).toEqual([{ instrument: "OLI", ...scenes }]);
    expect(imagery.get(49260)).toEqual([{ instrument: "OLI-2", ...scenes }]);
  });

  it("fails on a layer under several satellites that does not say so everywhere, and on a merged one under one", () => {
    const merged = { ...trueColour, merged: true };

    expect(() => imageryBySatellite({ satellites: [satellite(25994, { MODIS: [trueColour] }), satellite(27424, { MODIS: [trueColour] })] }, "core")).toThrow(
      'core satellites[0] "MODIS"[0]: its layer is also listed in core satellites[1] "MODIS"[0]; a layer that shows several satellites says "merged: true" under each',
    );
    // One satellite lists it under two instruments, and only once as merged.
    expect(() => imageryBySatellite({ satellites: [satellite(25994, { MODIS: [merged], MISR: [trueColour] }), satellite(27424, { MODIS: [merged] })] }, "core")).toThrow(
      'core satellites[0] "MISR"[0]: its layer is also listed in core satellites[0] "MODIS"[0]',
    );
    expect(() => imageryBySatellite({ satellites: [satellite(25994, { MODIS: [merged] })] }, "core")).toThrow(
      'core satellites[0] "MODIS"[0]: "merged" is for a layer listed under several satellites',
    );
    expect(() => imageryBySatellite({ satellites: [satellite(25994, { MODIS: [trueColour], MISR: [merged] })] }, "core")).toThrow(
      'core satellites[0] "MISR"[0]: "merged" is for a layer listed under several satellites',
    );
  });

  it("fails on one layer listed twice for one instrument, naming both places", () => {
    const viirs = satellite(43013, { VIIRS: [trueColour] });

    expect(() => imageryBySatellite({ satellites: [viirs, viirs] }, "core")).toThrow(
      'core satellites[1] "VIIRS"[0]: gibs TrueColor already shows VIIRS of noradId 43013 in core satellites[0] "VIIRS"[0]',
    );
  });

  it.each([
    [{ ...trueColour, kind: undefined }, '"kind" must be one of rgb'],
    [{ ...trueColour, kind: "band" }, '"kind" must be one of rgb'],
    [{ ...trueColour, period: "daily" }, '"period" must be an ISO 8601 duration'],
    [{ ...trueColour, window: "P" }, '"window" must be an ISO 8601 duration'],
    [{ ...trueColour, start: "2018" }, '"start" must be an ISO date'],
    [{ ...trueColour, end: "2026-13-45" }, '"end" must be an ISO date'],
    [{ ...trueColour, period: "P1DT" }, '"period" must be an ISO 8601 duration'],
    [{ ...trueColour, start: "2018-01-05", window: "P90D" }, "exclude each other"],
    [{ ...trueColour, url: "https://example.org" }, 'unknown key "url"'],
    [{ ...trueColour, label: undefined }, '"label" must say what the picture is'],
    [{ ...trueColour, provider: "NASA GIBS" }, '"provider" must be a lower-case name'],
    [{ ...trueColour, merged: "yes" }, '"merged" is true or absent'],
    ["TrueColor", "must be an object"],
  ])("fails on an entry it cannot read: %#", (entry, message) => {
    expect(() => imageryBySatellite({ satellites: [satellite(43013, { VIIRS: [entry] })] }, "core")).toThrow(message);
  });

  it.each([
    [{ satellites: [{ instruments: { VIIRS: [trueColour] } }] }, 'needs a numeric "noradId"'],
    [{ satellites: [satellite(43013, {})] }, '"instruments" must map an instrument\'s name to its imagery'],
    [{ satellites: [satellite(43013, { VIIRS: [] })] }, "must list at least one entry"],
    [{ satellites: [{ ...satellite(43013, { VIIRS: [trueColour] }), slot: "GOES-East" }] }, 'unknown key "slot"'],
    [{ slots: [] }, 'unknown key "slots"'],
  ])("fails on a manifest it cannot read: %#", (manifest, message) => {
    expect(() => imageryBySatellite(manifest, "core")).toThrow(message);
  });
});
