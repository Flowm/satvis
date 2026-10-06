import { describe, expect, it } from "vitest";

import type { FetchImpl } from "../src/gp/evaluate.ts";
import { parseSatcatCsv, SATCAT, SATCAT_URL } from "../src/gp/satcat.ts";
import { fetchUpstream } from "../src/gp/upstream.ts";

/** CelesTrak's real header, kept whole: the parser must survive ignored columns moving. */
const HEADER =
  "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE";

const ISS = "ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.94,51.63,424,414,399.0524,,EA,ORB";
const NAUKA = "ISS (NAUKA),2021-066A,49044,PAY,+,CIS,2021-07-21,TYMSC,,92.94,51.63,424,414,,,25544,DOC";

/** CRLF, as served. */
function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\r\n");
}

describe("parseSatcatCsv", () => {
  it("maps SATCAT columns onto the metadata bag's names", () => {
    const rows = parseSatcatCsv(csv(ISS));
    expect(rows["25544"]).toEqual({
      launchDate: "1998-11-20",
      launchSite: "TYMSC",
      opsStatus: "+",
      orbitType: "ORB",
      orbitCenter: "EA",
    });
  });

  it("drops the columns we deliberately do not serve", () => {
    const bag = parseSatcatCsv(csv(ISS))["25544"]!;
    // Why each one is excluded is on FIELDS in satcat.ts.
    for (const key of ["owner", "OWNER", "rcs", "RCS", "period", "PERIOD", "inclination", "apogee", "perigee", "objectType", "OBJECT_TYPE"]) {
      expect(bag).not.toHaveProperty(key);
    }
  });

  it("omits empty cells instead of storing them as empty strings", () => {
    const bag = parseSatcatCsv(csv(ISS))["25544"]!;
    // DECAY_DATE is empty for everything still in orbit, so this is the common case.
    expect(bag).not.toHaveProperty("decayDate");
  });

  it("reads the last column despite CRLF line endings", () => {
    // Splitting on \n alone would leave "ORB\r" in ORBIT_TYPE.
    expect(parseSatcatCsv(csv(ISS, NAUKA))["49044"]).toMatchObject({ orbitType: "DOC", orbitCenter: "25544" });
    expect(parseSatcatCsv(csv(ISS).replace(/\r\n/g, "\n"))["25544"]).toMatchObject({ orbitType: "ORB" });
  });

  it("handles quoted fields containing commas and escaped quotes", () => {
    const rows = parseSatcatCsv(csv(`"COSMOS 2221, DEB",1992-093A,25544,PAY,+,CIS,1992-12-25,PLMSC,,92.9,51.6,424,414,,,EA,ORB`));
    expect(rows["25544"]).toMatchObject({ launchDate: "1992-12-25", launchSite: "PLMSC", orbitType: "ORB" });

    const escaped = parseSatcatCsv(csv(`"SAT ""X""",1992-093A,25544,PAY,+,US,1992-12-25,AFETR,,92.9,51.6,424,414,,,EA,ORB`));
    expect(escaped["25544"]).toMatchObject({ launchSite: "AFETR" });
  });

  it("normalizes the satnum key the way enrichment looks it up", () => {
    // enrichmentSatnum strips leading zeros, so the table must too.
    const rows = parseSatcatCsv(csv(ISS.replace(",25544,", ",025544,")));
    expect(Object.keys(rows)).toEqual(["25544"]);
  });

  it("resolves columns by name, not position", () => {
    const reordered = ["ORBIT_TYPE,NORAD_CAT_ID,LAUNCH_SITE", "DOC,49044,TYMSC"].join("\r\n");
    expect(parseSatcatCsv(reordered)["49044"]).toEqual({ orbitType: "DOC", launchSite: "TYMSC" });
  });

  it("skips blank lines, including the trailing newline", () => {
    expect(Object.keys(parseSatcatCsv(`${csv(ISS, NAUKA)}\r\n`))).toEqual(["25544", "49044"]);
  });

  it("throws rather than returning a plausible-looking empty table", () => {
    // Otherwise each would enrich nothing and read as "SATCAT has no data".
    expect(() => parseSatcatCsv("")).toThrow(/empty body/);
    expect(() => parseSatcatCsv("<!DOCTYPE html><html><body>403</body></html>")).toThrow(/NORAD_CAT_ID/);
    expect(() => parseSatcatCsv(HEADER)).toThrow(/no records/);
    expect(() => parseSatcatCsv(csv("ISS (ZARYA),1998-067A,25544"))).toThrow(/3 fields, expected 17/);
  });
});

const badStatus: FetchImpl = async () => ({ status: 522, text: async () => "" });
const connectionReset: FetchImpl = async () => {
  throw new Error("connection reset");
};

// fetchUpstream through SATCAT's spec; the GCAT tables share the same code.
describe("fetchUpstream", () => {
  it("sends no conditional header when nothing is stored", async () => {
    let sent: Record<string, string> | undefined;
    const fetchImpl: FetchImpl = async (_url, init) => {
      sent = init?.headers;
      return { status: 200, text: async () => csv(ISS) };
    };
    const result = await fetchUpstream(fetchImpl, SATCAT);
    expect(sent).not.toHaveProperty("If-None-Match");
    // The body as served: storing it is what validates it (upstream.test.ts).
    expect(result.body).toBe(csv(ISS));
  });

  it("sends the stored ETag and reports a 304 without a body", async () => {
    let url: string | undefined;
    let sent: Record<string, string> | undefined;
    const fetchImpl: FetchImpl = async (requested, init) => {
      url = requested;
      sent = init?.headers;
      return { status: 304, text: async () => "" };
    };
    const result = await fetchUpstream(fetchImpl, SATCAT, '"abc123"');

    expect(url).toBe(SATCAT_URL);
    expect(sent!["If-None-Match"]).toBe('"abc123"');
    expect(result).toMatchObject({ status: 304, notModified: true });
    expect(result.body).toBeUndefined();
  });

  it("keeps the ETag so the next fetch can be conditional", async () => {
    const result = await fetchUpstream(
      async () => ({
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "etag" ? '"abc123"' : null) },
        text: async () => csv(ISS),
      }),
      SATCAT,
    );
    expect(result.etag).toBe('"abc123"');
  });

  it("reports every failure mode instead of throwing", async () => {
    expect(await fetchUpstream(badStatus, SATCAT)).toMatchObject({ status: 522, error: "HTTP 522" });
    expect(await fetchUpstream(connectionReset, SATCAT)).toMatchObject({ error: "connection reset" });
  });
});
