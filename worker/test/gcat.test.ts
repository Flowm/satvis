import { describe, expect, it } from "vitest";

import { GCAT_KEYS, gcatBags, parseGcatCatalog, parseGcatOrgs, parseGcatPayloads } from "../src/gp/gcat.ts";
import { parseSatcatCsv, SATCAT_KEYS } from "../src/gp/satcat.ts";
import { GCAT_CATALOG_HEADER, GCAT_CATALOG_LINES, GCAT_ORGS_HEADER, GCAT_ORGS_LINES, GCAT_PAYLOADS_LINES, gcatCatalog, gcatOrgs, gcatPayloads } from "./gcatFixtures.ts";

const { ISS, NAUKA, STARLINK_REENTERED, UNCATALOGUED, SPUTNIK_2_ATTACHED_REENTERED } = GCAT_CATALOG_LINES;

/** The first two columns swapped. */
function swapped(fields: string[]): string[] {
  return [fields[1]!, fields[0]!, ...fields.slice(2)];
}

describe("parseGcatCatalog", () => {
  it("maps GCAT columns onto the metadata bag's names, codes still codes", () => {
    expect(parseGcatCatalog(gcatCatalog(ISS))["25544"]).toEqual({
      jcat: "S25544",
      country: "US",
      bus: "77KS",
      manufacturer: "KHRR",
      operator: "JSC",
      massKg: 20281,
      lengthM: 12.6,
      diameterM: 4.2,
      spanM: 23.9,
      shape: "Cyl + 2 Pan",
      estimated: ["diameterM"],
    });
  });

  it("lists no estimates when GCAT flags none", () => {
    expect(parseGcatCatalog(gcatCatalog(NAUKA))["49044"]).not.toHaveProperty("estimated");
  });

  it("keeps objects still in orbit, attached or not, and drops the ones that are gone", () => {
    const rows = parseGcatCatalog(gcatCatalog(ISS, NAUKA, STARLINK_REENTERED, SPUTNIK_2_ATTACHED_REENTERED));
    // Grappled and docked are still up; reentered, alone or attached, is not.
    expect(Object.keys(rows).toSorted()).toEqual(["25544", "49044"]);
  });

  it("skips an object without a NORAD number", () => {
    expect(Object.keys(parseGcatCatalog(gcatCatalog(ISS, UNCATALOGUED)))).toEqual(["25544"]);
  });

  it("normalizes the satnum key the way enrichment looks it up", () => {
    // GCAT pads to five digits.
    const padded = ISS.replace("\t25544\t", "\t05544\t");
    expect(Object.keys(parseGcatCatalog(gcatCatalog(padded)))).toEqual(["5544"]);
  });

  it("omits GCAT's '-' cells instead of storing them", () => {
    const noBus = ISS.replace("\t77KS\t", "\t-\t");
    expect(parseGcatCatalog(gcatCatalog(noBus))["25544"]).not.toHaveProperty("bus");
  });

  it("resolves columns by name, not position", () => {
    const columns = GCAT_CATALOG_HEADER.slice(1).split("\t");
    const values = ISS.split("\t");
    const body = [`#${swapped(columns).join("\t")}`, swapped(values).join("\t")].join("\n");
    expect(parseGcatCatalog(body)["25544"]).toMatchObject({ country: "US", bus: "77KS" });
  });

  it("throws rather than returning a plausible-looking empty table", () => {
    // Otherwise each would enrich nothing and read as "GCAT has no data".
    expect(() => parseGcatCatalog("")).toThrow(/no header line/);
    expect(() => parseGcatCatalog("<!DOCTYPE html><html><body>403</body></html>")).toThrow(/no header line/);
    expect(() => parseGcatCatalog("#JCAT\tName\nS1\tx")).toThrow(/no Satcat column/);
    expect(() => parseGcatCatalog(gcatCatalog())).toThrow(/no records/);
    expect(() => parseGcatCatalog(gcatCatalog(STARLINK_REENTERED))).toThrow(/no records/);
    expect(() => parseGcatCatalog(gcatCatalog("S25544\t25544"))).toThrow(/2 fields, expected 42/);
  });

  it("reads CRLF line endings too", () => {
    expect(parseGcatCatalog(gcatCatalog(ISS).replace(/\n/g, "\r\n"))["25544"]).toMatchObject({ shape: "Cyl + 2 Pan" });
  });
});

describe("parseGcatPayloads", () => {
  it("keys purpose and owner type by JCAT, as codes", () => {
    expect(parseGcatPayloads(gcatPayloads(GCAT_PAYLOADS_LINES.ISS))).toEqual({ S25544: { category: "SS", class: "C" } });
  });

  it("throws on a body that is not the payload table", () => {
    expect(() => parseGcatPayloads("<html></html>")).toThrow(/no header line/);
    expect(() => parseGcatPayloads("#JCAT\tName\nS1\tx")).toThrow(/no Category column/);
  });
});

describe("parseGcatOrgs", () => {
  const names = parseGcatOrgs(gcatOrgs(...Object.values(GCAT_ORGS_LINES)));

  it("names a country or intergovernmental body by its short English name", () => {
    expect(names.US).toBe("USA");
    // Not "Rossiya" (the short name) or "Russian Federation" (the English name).
    expect(names.RU).toBe("Russia");
    expect(names["I-ESA"]).toBe("ESA");
  });

  it("names an organisation by its English name, else its name", () => {
    // NASA has no English name of its own; its name is English.
    expect(names.NASA).toBe("National Aeronautics and Space Administration");
    expect(names.RKKE).toBe("RKK Energiya");
  });

  it("throws on a body that is not the organisations table", () => {
    expect(() => parseGcatOrgs("<html></html>")).toThrow(/no header line/);
    expect(() => parseGcatOrgs(GCAT_ORGS_HEADER)).toThrow(/no records/);
  });
});

describe("gcatBags", () => {
  const catalog = parseGcatCatalog(gcatCatalog(ISS, NAUKA));
  const orgs = parseGcatOrgs(gcatOrgs(...Object.values(GCAT_ORGS_LINES)));
  const payloads = parseGcatPayloads(gcatPayloads(GCAT_PAYLOADS_LINES.ISS));

  it("names the country, maker and operator codes", () => {
    expect(gcatBags(catalog, orgs, payloads)["49044"]).toMatchObject({ country: "Russia", operator: "RKK Energiya" });
  });

  it("names each of several joined codes, and leaves a code the table lacks as it is", () => {
    // KHRO is not among the fixture's organisations.
    expect(gcatBags(catalog, orgs, payloads)["49044"]!.manufacturer).toBe("KHRO / RKK Energiya");
  });

  it("keeps the codes when there is no organisations table yet", () => {
    expect(gcatBags(catalog, undefined, undefined)["25544"]).toMatchObject({ country: "US", operator: "JSC" });
  });

  it("joins the payload table by JCAT, and serves no JCAT", () => {
    const bags = gcatBags(catalog, orgs, payloads);
    expect(bags["25544"]).toMatchObject({ category: "SS", class: "C" });
    expect(bags["25544"]).not.toHaveProperty("jcat");
    // Nauka is not among the fixture's payload rows.
    expect(bags["49044"]).not.toHaveProperty("category");
  });

  it("leaves the numbers and the estimate list untouched", () => {
    expect(gcatBags(catalog, orgs, payloads)["25544"]).toMatchObject({ massKg: 20281, estimated: ["diameterM"] });
  });
});

/** Every key any bag in a table carries. */
function emitted(bags: Record<string, Record<string, unknown>>): string[] {
  return [...new Set(Object.values(bags).flatMap(Object.keys))];
}

// ADR 0008: every field has one upstream owner, so a merge order never decides a value.
describe("field ownership", () => {
  it("gives SATCAT and GCAT no key in common", () => {
    expect(SATCAT_KEYS.filter((key) => GCAT_KEYS.includes(key))).toEqual([]);
  });

  it("declares every key each table actually emits", () => {
    const satcat = parseSatcatCsv(
      [
        "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE",
        "ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,2099-01-01,92.94,51.63,424,414,399.0524,,EA,ORB",
      ].join("\n"),
    );
    // Every column filled, so every key a parser could emit is here.
    const gcat = gcatBags(
      parseGcatCatalog(gcatCatalog(ISS, NAUKA)),
      parseGcatOrgs(gcatOrgs(...Object.values(GCAT_ORGS_LINES))),
      parseGcatPayloads(gcatPayloads(GCAT_PAYLOADS_LINES.ISS)),
    );

    expect(emitted(satcat).toSorted()).toEqual([...SATCAT_KEYS].toSorted());
    expect(emitted(gcat).filter((key) => !GCAT_KEYS.includes(key))).toEqual([]);
  });
});
