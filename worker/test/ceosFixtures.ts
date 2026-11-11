// CEOS's lists as its API serves them, cut to the fields the parser reads and a few it
// does not. ceos.test.ts, upstream.test.ts and refresh.test.ts share them.

import { CEOS_LIST_URLS, CEOS_META_URL, CEOS_WAVEBANDS_URL } from "../src/gp/ceos.ts";

type Entry = Record<string, unknown>;

/** One mission, with the fields a test does not set as CEOS fills them for a launched one. */
export function ceosMission(fields: Entry): Entry {
  return {
    mission_id: 1,
    mission_acronym: "Mission",
    full_name: "Mission",
    norad_id: 0,
    launch_date: "2000-01-01",
    eol_date: "2030-01-01",
    status: "Operational (nominal)",
    oscar_id: 0,
    instrument_names: "",
    instrument_details: "",
    slug: "mission",
    ...fields,
  };
}

export const CEOS_MISSIONS = {
  TERRA: ceosMission({
    mission_id: 204,
    mission_acronym: "Terra",
    norad_id: 25994,
    launch_date: "1999-12-18",
    status: "Operational (extended)",
    instrument_details:
      "ASTER~High resolution optical imagers~~High resolution optical imager~Albedo and reflectance;Ice sheet topography|MODIS~Imaging multi-spectral radiometers (vis/IR)~Ocean colour instruments~Medium-resolution spectro-radiometer~Aerosols;Aerosols",
  }),
  /** Hosted: launched 19 years after its host. */
  ECOSTRESS: ceosMission({
    mission_id: 765,
    mission_acronym: "ECOSTRESS-on-ISS",
    norad_id: 25544,
    launch_date: "2018-06-29",
    status: "Operational (extended)",
    instrument_details: "PHyTIR~Imaging multi-spectral radiometers (vis/IR)~~High-resolution nadir-scanning IR spectrometer~Surface temperature (land)",
  }),
  /** Hosted, and over. */
  HICO: ceosMission({
    mission_id: 781,
    mission_acronym: "HICO-on-ISS",
    norad_id: 25544,
    launch_date: "2009-09-25",
    status: "Mission complete",
    instrument_details: "HICO~Hyperspectral imagers~~~Ocean colour/biology",
  }),
  /** A constellation: its first launch, and the NORAD id of a unit launched ten years on. */
  BLACKSKY: ceosMission({
    mission_id: 1007,
    mission_acronym: "BlackSky Constellation",
    norad_id: 68098,
    launch_date: "2016-09-26",
    instrument_details: "SV-24~High resolution optical imagers~~High resolution optical imager~Multi-purpose imagery (land)",
  }),
};

/** PHyTIR has neither figure, HICO no swath, as CEOS has them. */
export const CEOS_INSTRUMENTS: Entry[] = [
  { instrument_id: 416, name_short: "ASTER", name_full: "Advanced Spaceborne Thermal Emission and Reflection Radiometer", spatial_resolution_best: 15.0, swath_width_max: 60 },
  { instrument_id: 395, name_short: "MODIS", name_full: "MODerate-Resolution Imaging Spectroradiometer", spatial_resolution_best: 250.0, swath_width_max: 2330 },
  { instrument_id: 1714, name_short: "PHyTIR", name_full: "Prototype HyspIRI Thermal Infrared Radiometer (PHyTIR)", spatial_resolution_best: null, swath_width_max: null },
  { instrument_id: 1737, name_short: "HICO", name_full: "Hyperspectral Imager for the Coastal Ocean", spatial_resolution_best: 90.0, swath_width_max: null },
  { instrument_id: 2007, name_short: "SV-24", name_full: "Spaceview-24", spatial_resolution_best: 1.0, swath_width_max: 30 },
];

/** mission id, instrument id. */
const CEOS_COMBINATIONS: [number, number][] = [
  [204, 416],
  [204, 395],
  [765, 1714],
  [781, 1737],
  [1007, 2007],
];

/** Two of CEOS's 17, in its order; each band's answer lists its instruments. */
const CEOS_WAVEBANDS: { waveband_id: number; abbr: string; instruments: number[] }[] = [
  { waveband_id: 2, abbr: "VIS", instruments: [416, 395, 1737, 2007] },
  { waveband_id: 6, abbr: "TIR", instruments: [416, 395, 1714] },
];

export const CEOS_VERSION = { registry_version: "sha256:e574f0c2", registry_generated_at: "2026-10-23T01:37:42Z" };

interface CeosParts {
  missions?: Entry[];
  instruments?: Entry[];
  combinations?: Entry[];
  wavebands?: Entry[];
  version?: Entry;
}

/** Each of CEOS's answers by its URL, the missions unpaged as CEOS sends them without a `limit`. */
export function ceosAnswers({ missions = Object.values(CEOS_MISSIONS), instruments = CEOS_INSTRUMENTS, combinations, wavebands, version = CEOS_VERSION }: CeosParts = {}): Map<
  string,
  string
> {
  const combined = combinations ?? CEOS_COMBINATIONS.map(([mission, instrument]) => ({ mission_id: mission, instrument_id: instrument, flat_id: `${mission}_${instrument}` }));
  const bands =
    wavebands ??
    CEOS_WAVEBANDS.map(({ waveband_id, abbr, instruments: tagged }) => ({ waveband_id, abbr, name: abbr, instruments: tagged.map((id) => ({ instrument_id: id, missions: [] })) }));
  const count = missions.length;
  return new Map([
    [CEOS_META_URL, JSON.stringify(version)],
    [CEOS_LIST_URLS.missions, JSON.stringify({ missions, pagination: { total: count, limit: count, offset: 0, returned: count, has_more: false } })],
    [CEOS_LIST_URLS.instruments, JSON.stringify({ instruments, total: instruments.length })],
    [CEOS_LIST_URLS.combinations, JSON.stringify({ combinations: combined, total: combined.length })],
    [CEOS_WAVEBANDS_URL, JSON.stringify({ wavebands: bands.map(({ instruments: _tagged, ...band }) => band) })],
    ...bands.map((band): [string, string] => [`${CEOS_WAVEBANDS_URL.replace(/s$/, "")}/${String(band.waveband_id)}`, JSON.stringify(band)]),
  ]);
}

/** The file the Worker stores: the lists as answered, put together as ceos.ts does. */
export function ceosFile(parts: CeosParts = {}): string {
  const answers = ceosAnswers(parts);
  const bands = [...answers].filter(([url]) => url.startsWith(`${CEOS_WAVEBANDS_URL.replace(/s$/, "")}/`)).map(([, body]) => body);
  return `{"missions":${answers.get(CEOS_LIST_URLS.missions)!},"instruments":${answers.get(CEOS_LIST_URLS.instruments)!},"combinations":${answers.get(CEOS_LIST_URLS.combinations)!},"wavebands":[${bands.join(",")}]}`;
}
