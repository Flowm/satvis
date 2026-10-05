import { describe, expect, test } from "vitest";

import { SatelliteCatalog } from "../modules/SatelliteCatalog";
import { SatelliteProperties } from "../modules/SatelliteProperties";
import type { GpRecord } from "../modules/util/gp";
import { InlinePassSource } from "../modules/util/passSource";
import { InlineSampleSource } from "../modules/util/sampleSource";
import type { SatelliteMetadata } from "./satelliteMetadata";

/** Minimal OMM record, with metadata attached as the worker does it. */
function ommRecord(name: string, satnum: number, metadata?: SatelliteMetadata): GpRecord {
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
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function propertiesFor(metadata?: SatelliteMetadata): SatelliteProperties {
  const catalog = new SatelliteCatalog();
  catalog.addRecords([ommRecord("TEST SAT", 1, metadata)], ["Test"]);
  const entry = catalog.getByName("TEST SAT")!;
  return new SatelliteProperties(entry, new InlineSampleSource().samplerFor(entry.satnum, entry.record), new InlinePassSource().predictorFor(entry.satnum, entry.record));
}

describe("record-carried satellite metadata", () => {
  test("an enriched record exposes its metadata verbatim", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("SENTINEL-3A", 41335, { swathStarboardKm: 1000, swathPortKm: 500 })], ["Weather"]);
    expect(catalog.getByName("SENTINEL-3A")!.metadata).toEqual({ swathStarboardKm: 1000, swathPortKm: 500 });
  });

  test("an unenriched record exposes an empty bag rather than undefined", () => {
    const catalog = new SatelliteCatalog();
    catalog.addRecords([ommRecord("PLAIN SAT", 99999)], ["Test"]);
    expect(catalog.getByName("PLAIN SAT")!.metadata).toEqual({});
  });
});

describe("swath resolution", () => {
  test("the total is the sum of the two sides, not a doubled half", () => {
    // Sentinel-3's tilted swath: 1000 + 500 is neither 2x1000 nor 2x500.
    expect(propertiesFor({ swathStarboardKm: 1000, swathPortKm: 500 }).swath).toBe(1500);
  });

  test("the sides are exposed for containment, which needs them apart", () => {
    expect(propertiesFor({ swathStarboardKm: 1000, swathPortKm: 500 }).swathExtents).toEqual({ starboardKm: 1000, portKm: 500 });
  });

  test("a satellite with no extents falls back to a symmetric 200 km total", () => {
    const props = propertiesFor();
    expect(props.swath).toBe(200);
    expect(props.swathExtents).toEqual({ starboardKm: 100, portKm: 100 });
  });

  test("swath and cone default independently — one field does not imply the other", () => {
    const props = propertiesFor({ swathStarboardKm: 1175, swathPortKm: 1175 });
    expect(props.swath).toBe(2350);
    expect(props.coneFovDeg).toBe(10);
  });

  test("cone FOV comes from the record when given", () => {
    expect(propertiesFor({ coneFovDeg: 45 }).coneFovDeg).toBe(45);
  });
});
