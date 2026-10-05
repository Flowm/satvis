import { describe, expect, test } from "vitest";

import { createSatrec, orbitClassOf, parseGpPayload, recordName, recordSatnum, recordTleLines, type GpRecord } from "./gp";

const OMM_ARRAY = JSON.stringify([
  {
    OBJECT_NAME: "ISS (ZARYA)",
    OBJECT_ID: "1998-067A",
    EPOCH: "2026-07-04T02:07:57.020160",
    MEAN_MOTION: 15.48879284,
    ECCENTRICITY: 0.00067632,
    INCLINATION: 51.6303,
    RA_OF_ASC_NODE: 216.4301,
    ARG_OF_PERICENTER: 253.0749,
    MEAN_ANOMALY: 106.9498,
    NORAD_CAT_ID: 25544,
    ELEMENT_SET_NO: 999,
    BSTAR: 0.00014587488,
    MEAN_MOTION_DOT: 7.564e-5,
    MEAN_MOTION_DDOT: 0,
  },
]);

const WORKER_TLE_ARRAY = JSON.stringify([
  {
    OBJECT_NAME: "PSEUDO-SAT",
    TLE_LINE1: "1 90001U 26001A   26185.00000000  .00000000  00000-0  00000-0 0  9990",
    TLE_LINE2: "2 90001  51.6000 000.0000 0000000 000.0000 000.0000 15.50000000000000",
  },
  // No OBJECT_NAME.
  {
    TLE_LINE1: "1 90002U 26002A   26185.00000000  .00000000  00000-0  00000-0 0  9991",
    TLE_LINE2: "2 90002  51.6000 000.0000 0000000 000.0000 000.0000 15.50000000000000",
  },
]);

const TLE_3LINE = [
  "ISS (ZARYA)",
  "1 25544U 98067A   26185.08885440  .00007564  00000+0  14587-3 0  9998",
  "2 25544  51.6303 216.4301 0006763 253.0749 106.9498 15.48879284574378",
].join("\n");

const TLE_3LINE_PREFIXED = [
  "0 ISS (ZARYA)",
  "1 25544U 98067A   26185.08885440  .00007564  00000+0  14587-3 0  9998",
  "2 25544  51.6303 216.4301 0006763 253.0749 106.9498 15.48879284574378",
].join("\n");

const TLE_2LINE = ["1 25544U 98067A   26185.08885440  .00007564  00000+0  14587-3 0  9998", "2 25544  51.6303 216.4301 0006763 253.0749 106.9498 15.48879284574378"].join("\n");

describe("parseGpPayload", () => {
  test("parses an OMM JSON array", () => {
    const records = parseGpPayload(OMM_ARRAY);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("omm");
    expect(recordName(records[0] as GpRecord)).toBe("ISS (ZARYA)");
    expect(recordSatnum(records[0] as GpRecord)).toBe("25544");
  });

  test("parses a worker TleRecord array, with satnum name fallback", () => {
    const records = parseGpPayload(WORKER_TLE_ARRAY);
    expect(records).toHaveLength(2);
    expect(records[0]?.kind).toBe("tle");
    expect(recordName(records[0] as GpRecord)).toBe("PSEUDO-SAT");
    expect(recordName(records[1] as GpRecord)).toBe("90002");
  });

  test("parses 3-line TLE text", () => {
    const records = parseGpPayload(TLE_3LINE);
    expect(records).toHaveLength(1);
    expect(recordName(records[0] as GpRecord)).toBe("ISS (ZARYA)");
    expect(recordSatnum(records[0] as GpRecord)).toBe("25544");
  });

  test("strips a leading '0 ' name prefix", () => {
    const records = parseGpPayload(TLE_3LINE_PREFIXED);
    expect(records).toHaveLength(1);
    expect(recordName(records[0] as GpRecord)).toBe("ISS (ZARYA)");
  });

  test("parses bare 2-line TLE blocks (no name line)", () => {
    const records = parseGpPayload(TLE_2LINE);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("tle");
    expect(recordName(records[0] as GpRecord)).toBe("25544");
    expect(recordSatnum(records[0] as GpRecord)).toBe("25544");
  });

  test("skips malformed blocks without throwing", () => {
    const garbage = ["garbage line one", "another junk line", TLE_3LINE, "trailing junk"].join("\n");
    const records = parseGpPayload(garbage);
    expect(records).toHaveLength(1);
    expect(recordSatnum(records[0] as GpRecord)).toBe("25544");
  });

  test("returns [] on invalid JSON without throwing", () => {
    expect(parseGpPayload("[not valid json")).toEqual([]);
  });
});

describe("recordSatnum normalization", () => {
  test("String(number) for OMM numeric ids", () => {
    const records = parseGpPayload(OMM_ARRAY);
    expect(recordSatnum(records[0] as GpRecord)).toBe("25544");
  });

  test("strips leading zeros for all-digit satnums", () => {
    const omm: GpRecord = {
      kind: "omm",
      omm: {
        OBJECT_NAME: "X",
        OBJECT_ID: "",
        EPOCH: "",
        MEAN_MOTION: 1,
        ECCENTRICITY: 0,
        INCLINATION: 0,
        RA_OF_ASC_NODE: 0,
        ARG_OF_PERICENTER: 0,
        MEAN_ANOMALY: 0,
        NORAD_CAT_ID: "00005",
        ELEMENT_SET_NO: 0,
        BSTAR: 0,
        MEAN_MOTION_DOT: 0,
        MEAN_MOTION_DDOT: 0,
      },
    };
    expect(recordSatnum(omm)).toBe("5");
  });

  test("keeps alpha-5 designators untouched", () => {
    const omm: GpRecord = {
      kind: "omm",
      omm: {
        OBJECT_NAME: "X",
        OBJECT_ID: "",
        EPOCH: "",
        MEAN_MOTION: 1,
        ECCENTRICITY: 0,
        INCLINATION: 0,
        RA_OF_ASC_NODE: 0,
        ARG_OF_PERICENTER: 0,
        MEAN_ANOMALY: 0,
        NORAD_CAT_ID: "E8493",
        ELEMENT_SET_NO: 0,
        BSTAR: 0,
        MEAN_MOTION_DOT: 0,
        MEAN_MOTION_DDOT: 0,
      },
    };
    expect(recordSatnum(omm)).toBe("E8493");
  });
});

describe("createSatrec", () => {
  test("builds a satrec from an OMM record", () => {
    const records = parseGpPayload(OMM_ARRAY);
    const satrec = createSatrec(records[0] as GpRecord);
    expect(satrec.error).toBe(0);
    expect(String(satrec.satnum)).toBe("25544");
  });

  test("builds a satrec from a TLE record", () => {
    const records = parseGpPayload(TLE_3LINE);
    const satrec = createSatrec(records[0] as GpRecord);
    expect(satrec.error).toBe(0);
    expect(String(satrec.satnum)).toBe("25544");
  });
});

describe("recordTleLines", () => {
  test("returns 3 lines for a TLE record and undefined for OMM", () => {
    const tle = parseGpPayload(TLE_3LINE)[0] as GpRecord;
    const omm = parseGpPayload(OMM_ARRAY)[0] as GpRecord;
    expect(recordTleLines(tle)).toHaveLength(3);
    expect(recordTleLines(omm)).toBeUndefined();
  });
});

describe("metadata lifting", () => {
  const OMM_ISS = JSON.parse(OMM_ARRAY)[0] as Record<string, unknown>;
  const [TLE_LINE1, TLE_LINE2] = TLE_2LINE.split("\n");

  test("lifts an OMM record's metadata off the element set", () => {
    const payload = JSON.stringify([{ ...OMM_ISS, metadata: { swathStarboardKm: 1000, swathPortKm: 500 } }]);
    const record = parseGpPayload(payload)[0]!;
    expect(record.metadata).toEqual({ swathStarboardKm: 1000, swathPortKm: 500, orbitClass: "LEO" });
    expect(record.kind).toBe("omm");
    expect(record.kind === "omm" && "metadata" in record.omm).toBe(false);
  });

  test("lifts a worker TLE record's metadata too", () => {
    const payload = JSON.stringify([
      {
        OBJECT_NAME: "ISS",
        TLE_LINE1: TLE_LINE1,
        TLE_LINE2: TLE_LINE2,
        metadata: { coneFovDeg: 45 },
      },
    ]);
    const record = parseGpPayload(payload)[0]!;
    expect(record.kind).toBe("tle");
    expect(record.metadata).toEqual({ coneFovDeg: 45, orbitClass: "LEO" });
  });

  test("carries nothing but the derived class on an unenriched record", () => {
    const record = parseGpPayload(JSON.stringify([OMM_ISS]))[0]!;
    expect(record.metadata).toEqual({ orbitClass: "LEO" });
  });

  test("ignores a metadata value that is not an object", () => {
    for (const bad of ["nope", 42, [1, 2], null]) {
      const record = parseGpPayload(JSON.stringify([{ ...OMM_ISS, metadata: bad }]))[0]!;
      expect(record.metadata, JSON.stringify(bad)).toEqual({ orbitClass: "LEO" });
    }
  });

  test("does not lift metadata out of legacy TLE text (no place to carry it)", () => {
    const record = parseGpPayload(`ISS\n${TLE_LINE1}\n${TLE_LINE2}`)[0]!;
    expect(record.metadata).toEqual({ orbitClass: "LEO" });
  });
});

describe("orbitClassOf", () => {
  function ommWithElements(meanMotion: number, eccentricity = 0.0001): GpRecord {
    const omm = JSON.stringify([{ ...(JSON.parse(OMM_ARRAY)[0] as Record<string, unknown>), MEAN_MOTION: meanMotion, ECCENTRICITY: eccentricity }]);
    return parseGpPayload(omm)[0]!;
  }

  test("classifies the regimes from mean motion", () => {
    expect(orbitClassOf(ommWithElements(15.5))).toBe("LEO"); // ISS-like, ~93 min
    expect(orbitClassOf(ommWithElements(2.0))).toBe("MEO"); // GPS-like, ~720 min
    expect(orbitClassOf(ommWithElements(1.0027))).toBe("GEO"); // geosynchronous, ~1436 min
  });

  test("eccentricity wins over period — a Molniya orbit is HEO, not MEO", () => {
    expect(orbitClassOf(ommWithElements(2.0, 0.72))).toBe("HEO");
  });

  test("reads the same elements out of a TLE, off the fixed columns of line 2", () => {
    expect(orbitClassOf(parseGpPayload(TLE_3LINE)[0]!)).toBe("LEO");
    // e=0.7168 only with the implied leading decimal point.
    const molniya = [
      "MOLNIYA 1-91",
      "1 25485U 98054A   26185.00000000  .00000000  00000-0  00000-0 0  9990",
      "2 25485  63.4000 000.0000 7168000 270.0000 000.0000  2.00612000000000",
    ].join("\n");
    expect(orbitClassOf(parseGpPayload(molniya)[0]!)).toBe("HEO");
  });

  test("covers every satellite, not only those in the satellite table", () => {
    expect(orbitClassOf(parseGpPayload(WORKER_TLE_ARRAY)[0]!)).toBe("LEO");
  });
});
