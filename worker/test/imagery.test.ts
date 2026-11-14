import { describe, expect, it } from "vitest";

import { imageryBySatellite } from "../src/gp/imagery.ts";

const trueColour = { provider: "gibs", layer: "TrueColor", label: "True colour", kind: "rgb" };

const satellite = (noradId: number, instruments: unknown) => ({ noradId, instruments });

describe("imageryBySatellite", () => {
  it("gives each satellite its instruments' entries in manifest order", () => {
    const granule = { ...trueColour, layer: "TrueColor_Granule", label: "True colour, per granule", period: "PT6M", window: "P90D", maxLevel: 9, format: "jpeg" };
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

  it("gives each satellite of a composite its entry, merged, after its own, with its own dates", () => {
    const ring = { provider: "eumetview", layer: "mumi:ring", label: "Natural colour", kind: "rgb", period: "PT3H", maxLevel: 6, format: "png" };
    const imagery = imageryBySatellite(
      {
        satellites: [satellite(60133, { ABI: [trueColour] })],
        composites: [
          {
            ...ring,
            satellites: [
              { noradId: 60133, name: "GOES 19", instrument: "ABI", start: "2025-04-07" },
              { noradId: 41836, instrument: "AHI" },
            ],
          },
        ],
      },
      "core",
    );

    expect(imagery.get(60133)).toEqual([
      { instrument: "ABI", ...trueColour },
      { instrument: "ABI", ...ring, start: "2025-04-07", merged: true },
    ]);
    expect(imagery.get(41836)).toEqual([{ instrument: "AHI", ...ring, merged: true }]);
  });

  it("fails on a layer listed in two places, and on a composite of fewer than two satellites", () => {
    const composite = {
      ...trueColour,
      satellites: [
        { noradId: 25994, instrument: "MODIS" },
        { noradId: 27424, instrument: "MODIS" },
      ],
    };

    expect(() => imageryBySatellite({ satellites: [satellite(25994, { MODIS: [trueColour] }), satellite(27424, { MODIS: [trueColour] })] }, "core")).toThrow(
      'core satellites[1] "MODIS"[0]: its layer is also listed in core satellites[0] "MODIS"[0]; a layer that shows several satellites is one composite, under "composites"',
    );
    expect(() => imageryBySatellite({ satellites: [satellite(25994, { MISR: [trueColour] })], composites: [composite] }, "core")).toThrow(
      'core composites[0]: its layer is also listed in core satellites[0] "MISR"[0]',
    );
    expect(() => imageryBySatellite({ composites: [composite, composite] }, "core")).toThrow("core composites[1]: its layer is also listed in core composites[0]");
    expect(() => imageryBySatellite({ composites: [{ ...composite, satellites: composite.satellites.slice(0, 1) }] }, "core")).toThrow(
      'core composites[0]: "satellites" must list the two or more satellites it shows',
    );
    expect(() => imageryBySatellite({ composites: [{ ...composite, satellites: [{ noradId: 25994 }, { noradId: 27424, instrument: "MODIS" }] }] }, "core")).toThrow(
      'core composites[0] satellites[0]: needs a numeric "noradId" and the "instrument" it shows',
    );
    expect(() => imageryBySatellite({ composites: [{ ...composite, satellites: [...composite.satellites, { noradId: 25994, instrument: "MODIS" }] }] }, "core")).toThrow(
      "core composites[0] satellites[2]: gibs TrueColor already shows MODIS of noradId 25994 in core composites[0] satellites[0]",
    );
  });

  it("takes one satellite's layer under two of its instruments", () => {
    const imagery = imageryBySatellite({ satellites: [satellite(25994, { MODIS: [trueColour], MISR: [trueColour] })] }, "core");

    expect(imagery.get(25994)?.map(({ instrument }) => instrument)).toEqual(["MODIS", "MISR"]);
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
    [{ ...trueColour, merged: true }, 'is a composite, listed once under "composites"'],
    [{ ...trueColour, maxLevel: 9 }, '"maxLevel" and "format" go together'],
    [{ ...trueColour, maxLevel: 9.5, format: "jpeg" }, '"maxLevel" must be a tile level'],
    [{ ...trueColour, maxLevel: 9, format: "gif" }, '"format" must be one of png, jpeg, webp'],
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
