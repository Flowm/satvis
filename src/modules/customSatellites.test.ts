import { describe, expect, test } from "vitest";

import { parseCustomElements, serializeCustomRecords } from "./customSatellites";
import { epochMsOf, orbitClassOf, parseGpPayload, recordName, recordSatnum } from "./util/gp";

const LINE1 = "1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992";
const LINE2 = "2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

/** The same ISS element set in every OMM format, named MY ISS. */
const OMM = {
  OBJECT_NAME: "MY ISS",
  OBJECT_ID: "1998-067A",
  EPOCH: "2018-12-08T16:38:40.623072",
  MEAN_MOTION: "15.54069892",
  ECCENTRICITY: "0.0005166",
  INCLINATION: "51.6407",
  RA_OF_ASC_NODE: "229.0798",
  ARG_OF_PERICENTER: "124.8351",
  MEAN_ANOMALY: "329.3296",
  NORAD_CAT_ID: "25544",
  BSTAR: "0.000041838",
  MEAN_MOTION_DOT: "0.00002284",
  MEAN_MOTION_DDOT: "0",
};

const CSV = `${Object.keys(OMM).join(",")}\n${Object.values(OMM).join(",")}`;

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<ndm><omm id="CCSDS_OMM_VERS" version="2.0"><header><CREATION_DATE/><ORIGINATOR/></header><body><segment>
<metadata><OBJECT_NAME>MY ISS</OBJECT_NAME><OBJECT_ID>1998-067A</OBJECT_ID><CENTER_NAME>EARTH</CENTER_NAME></metadata>
<data><meanElements><EPOCH>2018-12-08T16:38:40.623072</EPOCH><MEAN_MOTION units="rev/day">15.54069892</MEAN_MOTION><ECCENTRICITY>.0005166</ECCENTRICITY>
<INCLINATION units="deg">51.6407</INCLINATION><RA_OF_ASC_NODE>229.0798</RA_OF_ASC_NODE><ARG_OF_PERICENTER>124.8351</ARG_OF_PERICENTER>
<MEAN_ANOMALY>329.3296</MEAN_ANOMALY></meanElements><tleParameters><NORAD_CAT_ID>25544</NORAD_CAT_ID><BSTAR>.41838E-4</BSTAR>
<MEAN_MOTION_DOT>.2284E-4</MEAN_MOTION_DOT><MEAN_MOTION_DDOT>0</MEAN_MOTION_DDOT></tleParameters></data></segment></body></omm></ndm>`;

const KVN = `CCSDS_OMM_VERS = 2.0
COMMENT made by hand
OBJECT_NAME = MY ISS
OBJECT_ID = 1998-067A
EPOCH = 2018-12-08T16:38:40.623072
MEAN_MOTION = 15.54069892 [rev/day]
ECCENTRICITY = 0.0005166
INCLINATION = 51.6407 [deg]
RA_OF_ASC_NODE = 229.0798 [deg]
ARG_OF_PERICENTER = 124.8351 [deg]
MEAN_ANOMALY = 329.3296 [deg]
NORAD_CAT_ID = 25544`;

describe("parseCustomElements", () => {
  test.each([
    ["a 3LE", `MY ISS\n${LINE1}\n${LINE2}`],
    ["OMM JSON", JSON.stringify([OMM])],
    ["OMM CSV", CSV],
    ["OMM XML", XML],
    ["OMM KVN, its drag terms left out", KVN],
  ])("reads %s", (_format, text) => {
    const { records, problems } = parseCustomElements(text);
    expect(problems).toEqual([]);
    expect(records.map((record) => [recordName(record), recordSatnum(record), orbitClassOf(record)])).toEqual([["MY ISS", "25544", "LEO"]]);
    expect(epochMsOf(records[0]!)).toBeCloseTo(Date.UTC(2018, 11, 8, 16, 38, 40, 623), -2);
  });

  test("names a bare TLE by its NORAD id", () => {
    expect(parseCustomElements(`${LINE1}\n${LINE2}`).records.map(recordName)).toEqual(["25544"]);
  });

  test("keeps a KVN name's brackets, which are no unit", () => {
    expect(parseCustomElements(KVN.replace("OBJECT_NAME = MY ISS", "OBJECT_NAME = MY ISS [DTC]")).records.map(recordName)).toEqual(["MY ISS [DTC]"]);
  });

  test("keeps a CSV name's quoted comma", () => {
    const quoted = CSV.replace("MY ISS", '"MY ISS, COPY"');
    expect(parseCustomElements(quoted).records.map(recordName)).toEqual(["MY ISS, COPY"]);
  });

  test("says why it dropped a block, and keeps the rest", () => {
    const { records, problems } = parseCustomElements(`MY ISS\n${LINE1}\n${LINE2}\nBROKEN\n${LINE1}\n`);
    expect(records.map(recordName)).toEqual(["MY ISS"]);
    expect(problems).toEqual(["Skipping malformed TLE block at line 4: expected name + 2 TLE lines", "Skipping malformed TLE block at line 5: line 2 missing or invalid"]);
  });

  test("refuses an OMM without the elements SGP4 needs", () => {
    const { MEAN_MOTION: _dropped, ...partial } = OMM;
    expect(parseCustomElements(JSON.stringify(partial))).toEqual({ records: [], problems: ["MY ISS lacks MEAN_MOTION"] });
  });

  test("refuses elements SGP4 cannot propagate", () => {
    expect(parseCustomElements(JSON.stringify({ ...OMM, ECCENTRICITY: "1.5" })).problems).toEqual(["MY ISS does not propagate: check its numbers"]);
  });

  test("refuses a catalog satellite's name and a name listed twice", () => {
    const text = `ISS (ZARYA)\n${LINE1}\n${LINE2}\nMY ISS\n${LINE1}\n${LINE2}\nMY ISS\n${LINE1}\n${LINE2}`;
    const { records, problems } = parseCustomElements(text, (name) => name === "ISS (ZARYA)");
    expect(records.map(recordName)).toEqual(["MY ISS"]);
    expect(problems).toEqual(["ISS (ZARYA) is the name of a catalog satellite; rename it", "MY ISS is listed twice"]);
  });

  test("finds nothing in prose", () => {
    expect(parseCustomElements("hello")).toEqual({
      records: [],
      problems: ["Skipping malformed TLE block at line 1: expected name + 2 TLE lines", expect.stringContaining("No element set found")],
    });
    expect(parseCustomElements("  ")).toEqual({ records: [], problems: [] });
  });
});

describe("serializeCustomRecords", () => {
  test("stores a GP payload that reads back as the same records", () => {
    const both = [...parseCustomElements(`MY TLE\n${LINE1}\n${LINE2}`).records, ...parseCustomElements(JSON.stringify(OMM)).records];
    const back = parseGpPayload(serializeCustomRecords(both));
    expect(back).toEqual(both);
  });
});
