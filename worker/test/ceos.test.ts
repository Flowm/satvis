import { describe, expect, it } from "vitest";

import { CEOS, CEOS_KEYS, CEOS_META_URL, ceosBags, parseCeos } from "../src/gp/ceos.ts";
import { GCAT_KEYS } from "../src/gp/gcat.ts";
import { SATCAT_KEYS } from "../src/gp/satcat.ts";
import { fetchUpstream } from "../src/gp/upstream.ts";
import { CEOS_ETAG, CEOS_INSTRUMENTS, CEOS_MISSIONS, CEOS_VERSION, ceosAnswers, ceosFetch, ceosFile, ceosMission } from "./ceosFixtures.ts";

const { TERRA, ECOSTRESS, HICO } = CEOS_MISSIONS;

const ASTER = {
  name: "ASTER",
  fullName: "Advanced Spaceborne Thermal Emission and Reflection Radiometer",
  kind: "High resolution optical imager",
  bands: ["VIS", "TIR"],
  resolutionM: 15,
  nominalSwathKm: 60,
};
const MODIS = {
  name: "MODIS",
  fullName: "MODerate-Resolution Imaging Spectroradiometer",
  kind: "Medium-resolution spectro-radiometer",
  bands: ["VIS", "TIR"],
  resolutionM: 250,
  nominalSwathKm: 2330,
};
const PHYTIR = { name: "PHyTIR", fullName: "Prototype HyspIRI Thermal Infrared Radiometer (PHyTIR)", kind: "High-resolution nadir-scanning IR spectrometer", bands: ["TIR"] };
const HICO_INSTRUMENT = { name: "HICO", fullName: "Hyperspectral Imager for the Coastal Ocean", kind: "Hyperspectral imagers", bands: ["VIS"], resolutionM: 90 };

describe("CEOS.assemble", () => {
  it("puts the lists and every waveband into one file, versioned by the snapshot", async () => {
    const asked: string[] = [];
    const file = await fetchUpstream(ceosFetch(ceosAnswers(), asked), CEOS);

    expect(file.error).toBeUndefined();
    expect(file.body).toBe(ceosFile());
    expect(file.etag).toBe(CEOS_ETAG);
    // The version, three lists, the wavebands, two bands, and the version again.
    expect(asked).toHaveLength(8);
    expect(parseCeos(file.body!)["25994"]![0]!.instruments).toEqual([ASTER, MODIS]);
  });

  it("asks only for the version while the stored file's stands", async () => {
    const asked: string[] = [];
    const file = await fetchUpstream(ceosFetch(ceosAnswers(), asked), CEOS, CEOS_ETAG);

    expect(file).toMatchObject({ status: 200, notModified: true });
    expect(file.body).toBeUndefined();
    expect(asked).toEqual([CEOS_META_URL]);
  });

  it("downloads again when a snapshot is loaded, even one with the same identifiers", async () => {
    const reloaded = ceosAnswers({ version: { ...CEOS_VERSION, registry_generated_at: "2026-11-02T00:00:00Z" } });
    const file = await fetchUpstream(ceosFetch(reloaded), CEOS, CEOS_ETAG);
    expect(file.body).toBeDefined();
  });

  it("fails when a snapshot is loaded between the downloads, rather than storing a mix of two", async () => {
    const answers = ceosAnswers();
    const asked: string[] = [];
    const serve = ceosFetch(answers, asked);
    const file = await fetchUpstream(async (url, init) => {
      if (asked.length === 1) {
        answers.set(CEOS_META_URL, JSON.stringify({ ...CEOS_VERSION, registry_generated_at: "2026-11-02T00:00:00Z" }));
      }
      return serve(url, init);
    }, CEOS);

    expect(file.body).toBeUndefined();
    expect(file.error).toBe("the snapshot changed during the download");
  });

  it("fails whole when one download does, naming it", async () => {
    const answers = ceosAnswers();
    const band = [...answers.keys()].at(-1)!;
    answers.delete(band);
    const file = await fetchUpstream(ceosFetch(answers), CEOS);

    expect(file.body).toBeUndefined();
    expect(file.error).toBe(`HTTP 404 for ${band}`);
  });
});

describe("parseCeos", () => {
  it("keys a mission by its NORAD id, each instrument with its name, kind, bands, resolution and swath", () => {
    expect(parseCeos(ceosFile({ missions: [TERRA] }))).toEqual({
      "25994": [{ name: "Terra", launchDate: "1999-12-18", instruments: [ASTER, MODIS] }],
    });
  });

  it("names an instrument's type where CEOS gives no technology, and leaves out a figure it lacks", () => {
    const rows = parseCeos(ceosFile({ missions: [ECOSTRESS, HICO] }));
    expect(rows["25544"]!.flatMap(({ instruments }) => instruments)).toEqual([HICO_INSTRUMENT, PHYTIR]);
  });

  it("joins a mission to its instruments by id, not by a short name two instruments share", () => {
    const sharing = ceosFile({
      missions: [ceosMission({ mission_id: 7, norad_id: 40000, instrument_details: "AIS~Data collection~~Data collection system~" })],
      instruments: [
        { instrument_id: 1, name_short: "AIS", name_full: "The other AIS", spatial_resolution_best: 5, swath_width_max: null },
        { instrument_id: 2, name_short: "AIS", name_full: "Automatic Identification System", spatial_resolution_best: null, swath_width_max: 600 },
      ],
      combinations: [{ mission_id: 7, instrument_id: 2 }],
    });
    expect(parseCeos(sharing)["40000"]![0]!.instruments).toEqual([
      { name: "AIS", fullName: "Automatic Identification System", kind: "Data collection system", nominalSwathKm: 600 },
    ]);
  });

  it("keeps the name and kind of an instrument the combinations do not list", () => {
    const rows = parseCeos(ceosFile({ missions: [TERRA], combinations: [{ mission_id: 204, instrument_id: 395 }] }));
    expect(rows["25994"]![0]!.instruments).toEqual([{ name: "ASTER", kind: "High resolution optical imager" }, MODIS]);
  });

  it("finds an instrument whose name CEOS ends in a space or a newline", () => {
    const untrimmed = CEOS_INSTRUMENTS.map((instrument) =>
      instrument.name_short === "ASTER" ? { ...instrument, name_short: "ASTER \n", name_full: `${String(instrument.name_full)} ` } : instrument,
    );
    expect(parseCeos(ceosFile({ missions: [TERRA], instruments: untrimmed }))["25994"]![0]!.instruments).toEqual([ASTER, MODIS]);
  });

  it("leaves out a full name that only repeats the short one", () => {
    const repeated = [
      ...CEOS_INSTRUMENTS.filter(({ name_short: name }) => name !== "MODIS"),
      { instrument_id: 395, name_short: "MODIS", name_full: "MODIS", spatial_resolution_best: 250, swath_width_max: 2330 },
    ];
    expect(parseCeos(ceosFile({ missions: [TERRA], instruments: repeated }))["25994"]![0]!.instruments[1]).not.toHaveProperty("fullName");
  });

  it("retires the instruments of a mission that is over", () => {
    const [hico, ecostress] = parseCeos(ceosFile({ missions: [ECOSTRESS, HICO] }))["25544"]!;
    expect(hico).toMatchObject({ name: "HICO-on-ISS", retired: true });
    expect(ecostress).not.toHaveProperty("retired");
  });

  it("retires nothing on a status that does not say the mission is over", () => {
    for (const status of ["N/A", "Uncertain", "Commissioning", null]) {
      expect(parseCeos(ceosFile({ missions: [{ ...TERRA, status }] }))["25994"]![0]).not.toHaveProperty("retired");
    }
  });

  it("lists a satellite's missions by launch, whatever order CEOS gives them in", () => {
    expect(parseCeos(ceosFile({ missions: [ECOSTRESS, HICO] }))["25544"]!.map(({ name }) => name)).toEqual(["HICO-on-ISS", "ECOSTRESS-on-ISS"]);
  });

  it("skips a mission with no NORAD id, and one with no instruments", () => {
    const rows = parseCeos(ceosFile({ missions: [TERRA, ceosMission({ instrument_details: "A~B~~C~D" }), ceosMission({ norad_id: 27424 })] }));
    expect(Object.keys(rows)).toEqual(["25994"]);
  });

  it("throws rather than storing one page of the missions as all of them", () => {
    const file = JSON.parse(ceosFile()) as { missions: { pagination: Record<string, unknown> } };
    file.missions.pagination = { total: 1200, limit: 100, offset: 0, returned: 100, has_more: true };
    expect(() => parseCeos(JSON.stringify(file))).toThrow("one page of the missions: 100 of 1200");
  });

  it("throws on a body that is not the file, or has lost a list or a field the parser reads", () => {
    expect(() => parseCeos("<html>503</html>")).toThrow(/not JSON/);
    expect(() => parseCeos('{"detail":"Not Found"}')).toThrow("no missions list");
    expect(() => parseCeos(ceosFile({ wavebands: [] }))).toThrow("no wavebands list");
    const { norad_id: _renamed, ...renamed } = TERRA;
    expect(() => parseCeos(ceosFile({ missions: [{ ...renamed, norad: 25994 }] }))).toThrow("no norad_id field in missions");
    expect(() => parseCeos(ceosFile({ combinations: [{ mission: 204, instrument: 416 }] }))).toThrow("no mission_id field in combinations");
    expect(() => parseCeos(ceosFile({ missions: [ceosMission({})] }))).toThrow(/no records/);
  });
});

describe("ceosBags", () => {
  const rows = parseCeos(ceosFile());
  const satcat = {
    "25994": { launchDate: "1999-12-18" },
    "25544": { launchDate: "1998-11-20" },
    "68098": { launchDate: "2026-03-05" },
  };

  it("gives a satellite the instruments of the mission launched with it", () => {
    expect(ceosBags(rows, satcat)["25994"]).toEqual({ instruments: [ASTER, MODIS] });
  });

  it("gives a host its hosted payloads, the ones still flown first", () => {
    expect(ceosBags(rows, satcat)["25544"]).toEqual({ instruments: [PHYTIR, { ...HICO_INSTRUMENT, retired: true }] });
  });

  it("gives a constellation's mission to no satellite launched after it", () => {
    expect(ceosBags(rows, satcat)).not.toHaveProperty("68098");
  });

  it("allows the day by which the two sources differ on a launch near midnight", () => {
    expect(ceosBags(rows, { "25994": { launchDate: "1999-12-19" } })).toHaveProperty("25994");
    expect(ceosBags(rows, { "25994": { launchDate: "1999-12-20" } })).not.toHaveProperty("25994");
  });

  it("claims nothing for a satellite whose launch SATCAT does not give", () => {
    expect(ceosBags(rows, { "25994": {} })).toEqual({});
    expect(ceosBags(rows, undefined)).toEqual({});
    expect(ceosBags(undefined, satcat)).toEqual({});
  });

  it("counts an instrument two missions name once, retired only if both are", () => {
    const shared = "UVNS~Atmospheric chemistry~~High-resolution nadir-scanning SW spectrometer~Ozone";
    const over = ceosMission({ mission_id: 8, mission_acronym: "Host", norad_id: 65159, launch_date: "2025-08-13", status: "Mission complete", instrument_details: shared });
    const flying = ceosMission({ mission_id: 9, mission_acronym: "Hosted", norad_id: 65159, launch_date: "2025-08-14", instrument_details: shared });
    const launched = { "65159": { launchDate: "2025-08-13" } };
    const uvns = { name: "UVNS", kind: "High-resolution nadir-scanning SW spectrometer" };

    // By launch, so the mission that is over comes first, then last.
    expect(ceosBags(parseCeos(ceosFile({ missions: [over, flying] })), launched)["65159"]).toEqual({ instruments: [uvns] });
    expect(ceosBags(parseCeos(ceosFile({ missions: [{ ...over, launch_date: "2025-08-15" }, flying] })), launched)["65159"]).toEqual({ instruments: [uvns] });
    expect(ceosBags(parseCeos(ceosFile({ missions: [over, { ...flying, status: "Mission complete" }] })), launched)["65159"]).toEqual({
      instruments: [{ ...uvns, retired: true }],
    });
  });
});

// ADR 0008: every field has one upstream owner, so a merge order never decides a value.
describe("field ownership", () => {
  it("gives CEOS no key in common with SATCAT or GCAT", () => {
    expect(CEOS_KEYS.filter((key) => SATCAT_KEYS.includes(key) || GCAT_KEYS.includes(key))).toEqual([]);
  });

  it("declares every key CEOS emits", () => {
    const bags = ceosBags(parseCeos(ceosFile({ missions: [TERRA] })), { "25994": { launchDate: "1999-12-18" } });
    expect([...new Set(Object.values(bags).flatMap(Object.keys))]).toEqual([...CEOS_KEYS]);
  });
});
