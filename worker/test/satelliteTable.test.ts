import { describe, expect, it } from "vitest";

import { SatelliteTable } from "../src/gp/satelliteTable.ts";
import type { GpRecord, OmmRecord, SatelliteEntry } from "../src/gp/types.ts";

function omm(name: string, id: number): OmmRecord {
  return { OBJECT_NAME: name, NORAD_CAT_ID: id };
}

function metadataOf(record: GpRecord): unknown {
  return (record as OmmRecord).metadata;
}

const curated = (...entries: SatelliteEntry[]) => new SatelliteTable([], entries);

const satcat = (bags: Record<string, Record<string, unknown>>) => ({ name: "satcat", bags });
const gcat = (bags: Record<string, Record<string, unknown>>) => ({ name: "gcat", bags });

describe("SatelliteTable", () => {
  it("lays a curated row over the upstream one field by field", () => {
    const table = new SatelliteTable(
      [satcat({ "25994": { launchDate: "1999-12-18" } }), gcat({ "25994": { country: "US" } })],
      [{ noradId: 25994, metadata: { swathStarboardKm: 1175, country: "USA" } }],
    );

    expect(metadataOf(table.enrich([omm("TERRA", 25994)])[0]!)).toEqual({ launchDate: "1999-12-18", country: "USA", swathStarboardKm: 1175 });
  });

  it("gives a satellite of a listed bus that bus's model, unless one is named for it", () => {
    const table = new SatelliteTable(
      [gcat({ "1": { bus: "Starlink V2M" }, "2": { bus: "Starlink V2M" }, "3": { bus: "A2100" } })],
      [{ noradId: 2, metadata: { modelFile: "special.glb" } }],
      { "Starlink V2M": "starlink.glb" },
    );
    const [one, two, three] = table.enrich([omm("A", 1), omm("B", 2), omm("C", 3)]);

    expect(metadataOf(one!)).toMatchObject({ modelFile: "starlink.glb" });
    expect(metadataOf(two!)).toMatchObject({ modelFile: "special.glb" });
    expect(metadataOf(three!)).not.toHaveProperty("modelFile");
  });

  it("counts the rows each upstream table gave", () => {
    const table = new SatelliteTable([satcat({ "1": {}, "2": {} }), gcat({})]);
    expect(table.rows).toEqual({ satcat: 2, gcat: 0 });
  });
});

describe("SatelliteTable.enrich", () => {
  const terra: SatelliteEntry = { noradId: 25994, name: "TERRA", metadata: { swathStarboardKm: 1175, swathPortKm: 1175 } };

  it("attaches metadata to the matching record only", () => {
    const records = curated(terra).enrich([omm("TERRA", 25994), omm("AQUA", 27424)]);
    expect(metadataOf(records[0]!)).toEqual({ swathStarboardKm: 1175, swathPortKm: 1175 });
    expect(records[1]).not.toHaveProperty("metadata");
  });

  it("does not mutate the input records", () => {
    const input = omm("TERRA", 25994);
    curated(terra).enrich([input]);
    expect(input).not.toHaveProperty("metadata");
  });

  it("matches a satnum regardless of numeric form or leading zeros", () => {
    for (const id of [25994, "25994", "025994"] as const) {
      const records = curated(terra).enrich([{ OBJECT_NAME: "TERRA", NORAD_CAT_ID: id }]);
      expect(metadataOf(records[0]!), String(id)).toBeDefined();
    }
  });

  it("matches by satnum, not by name — a renamed record still gets its metadata", () => {
    const records = curated({ noradId: 63354, name: "LEMUR-2-THERMORAPTOR", metadata: { coneFovDeg: 30 } }).enrich([omm("FOREST-5", 63354)]);
    expect(metadataOf(records[0]!)).toEqual({ coneFovDeg: 30 });
  });

  it("reaches TleRecord extras via columns 3-8 of line 1", () => {
    const tle: GpRecord = {
      OBJECT_NAME: "ISS",
      TLE_LINE1: "1 25544U 98067A   26187.50000000  .00016717  00000-0  10270-3 0  9999",
      TLE_LINE2: "2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537",
    };
    const records = curated({ noradId: 25544, metadata: { coneFovDeg: 45 } }).enrich([tle]);
    expect(metadataOf(records[0]!)).toEqual({ coneFovDeg: 45 });
  });

  it("reports the curated rows nothing matched, but not a decayed one", () => {
    const table = curated(terra, { noradId: 99999, metadata: { coneFovDeg: 1 } }, { noradId: 88888, metadata: {}, decayed: true });
    table.enrich([omm("TERRA", 25994)]);
    expect(table.unmatched().map((entry) => entry.noradId)).toEqual([99999]);
  });

  it("returns the records untouched when the table is empty", () => {
    const input = [omm("TERRA", 25994)];
    expect(curated().enrich(input)).toBe(input);
  });
});
