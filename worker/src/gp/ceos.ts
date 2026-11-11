// CEOS's MIM database, a contributor to the satellite table (ADR 0018): which instruments
// a satellite carries, and what each is. CC BY 4.0, "CEOS MIM Database,
// https://database.eohandbook.com". The stored file and its status are upstream.ts's.

import { normalizeSatnumKey } from "./satnum.ts";
import type { CeosMission, CeosRows, SatelliteInstrument } from "./types.ts";
import type { UpstreamSpec } from "./upstream.ts";

/** A beta API: a renamed field fails the parse, and the stored file stands. */
const CEOS_API = "https://ceos-capabilities.org/api";

/** The snapshot's version, which CEOS says to ask before downloading again. */
export const CEOS_META_URL = `${CEOS_API}/meta`;

/**
 * The lists the file is put together from, each one answer: the missions (~1.9 MB, whole
 * while no `limit` is sent), the instruments (~0.6 MB), and which mission carries which
 * (~0.4 MB). The missions name their instruments by short name alone, and five
 * instruments are named "AIS", so only the combinations join the two.
 */
export const CEOS_LIST_URLS = { missions: `${CEOS_API}/missions`, instruments: `${CEOS_API}/instruments`, combinations: `${CEOS_API}/combinations` } as const;

/** The wavebands, and through `/waveband/<id>` each one's instruments: 17 bands, ~2.1 MB. */
export const CEOS_WAVEBANDS_URL = `${CEOS_API}/wavebands`;

/** The metadata keys CEOS owns; no other upstream table may write them (ADR 0008). */
export const CEOS_KEYS: readonly string[] = ["instruments"];

/** The fields the parser reads, by list; one missing from a list's first entry fails the parse. */
const FIELDS = {
  missions: ["mission_id", "norad_id", "mission_acronym", "launch_date", "status", "instrument_details"],
  instruments: ["instrument_id", "name_short", "name_full", "spatial_resolution_best", "swath_width_max"],
  combinations: ["mission_id", "instrument_id"],
  wavebands: ["abbr", "instruments"],
} as const;

/** The statuses of a mission still flying its instruments; any other retires them. */
const OPERATING = /^(Operational|Commissioning)/;

/**
 * How far before the satellite's launch a mission's may lie. The two sources disagree by
 * a day for 32 of 302 served satellites, a launch near midnight UTC; the nearest
 * constellation is 266 days out.
 */
const LAUNCH_SLACK_DAYS = 1;

type Entry = Record<string, unknown>;

/**
 * The file: the version first, then each list as CEOS answered it, the wavebands in the
 * order CEOS lists them. `etag` is the stored file's version.
 */
async function assembleCeos(get: (url: string) => Promise<string>, etag: string | undefined): Promise<{ body: string; etag: string } | undefined> {
  const meta = JSON.parse(await get(CEOS_META_URL)) as { registry_version?: unknown; registry_generated_at?: unknown };
  if (typeof meta.registry_version !== "string") {
    throw new Error("no registry_version in /meta");
  }
  // The hash is of the identifiers; the time says a snapshot was loaded, even one that changed none.
  const version = `${meta.registry_version}@${String(meta.registry_generated_at)}`;
  if (version === etag) {
    return undefined;
  }
  const missions = await get(CEOS_LIST_URLS.missions);
  const instruments = await get(CEOS_LIST_URLS.instruments);
  const combinations = await get(CEOS_LIST_URLS.combinations);
  const index = JSON.parse(await get(CEOS_WAVEBANDS_URL)) as { wavebands?: { waveband_id?: unknown }[] };
  if (!Array.isArray(index.wavebands) || index.wavebands.length === 0) {
    throw new Error("no wavebands list");
  }
  const wavebands = await Promise.all(index.wavebands.map(({ waveband_id: id }) => get(`${CEOS_API}/waveband/${String(id)}`)));
  return { body: `{"missions":${missions},"instruments":${instruments},"combinations":${combinations},"wavebands":[${wavebands.join(",")}]}`, etag: version };
}

/** A non-empty list whose first entry has every field the parser reads of it. */
function listOf(list: unknown, name: keyof typeof FIELDS): Entry[] {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`no ${name} list`);
  }
  for (const field of FIELDS[name]) {
    if (typeof list[0] !== "object" || list[0] === null || !(field in list[0])) {
      throw new Error(`no ${field} field in ${name}`);
    }
  }
  return list as Entry[];
}

const positive = (value: unknown): number | undefined => (typeof value === "number" && value > 0 ? value : undefined);

/** What the instrument list and the wavebands say of one instrument. */
interface Detail {
  name: string;
  fullName?: string;
  figures: Pick<SatelliteInstrument, "bands" | "resolutionM" | "swathKm">;
}

/** Each instrument's detail, by its id. */
function instrumentDetails(instruments: Entry[], wavebands: Entry[]): Map<unknown, Detail> {
  const bands = new Map<unknown, string[]>();
  for (const { abbr, instruments: tagged } of wavebands) {
    for (const { instrument_id: id } of Array.isArray(tagged) ? (tagged as Entry[]) : []) {
      if (typeof abbr === "string") {
        bands.set(id, [...(bands.get(id) ?? []), abbr]);
      }
    }
  }
  const details = new Map<unknown, Detail>();
  for (const { instrument_id: id, name_short: name, name_full: fullName, spatial_resolution_best: resolution, swath_width_max: swath } of instruments) {
    if (typeof name !== "string") {
      continue;
    }
    const resolutionM = positive(resolution);
    const swathKm = positive(swath);
    details.set(id, {
      name,
      ...(typeof fullName === "string" && fullName !== "" && fullName !== name && { fullName }),
      figures: { ...(bands.has(id) && { bands: bands.get(id) }), ...(resolutionM !== undefined && { resolutionM }), ...(swathKm !== undefined && { swathKm }) },
    });
  }
  return details;
}

/**
 * `instrument_details`: instruments joined with "|", each as
 * name~type~second type~technology~measurements. The name comes first, so a field added
 * after it does not move it. `carried` are the mission's instruments by the combinations,
 * matched by name: within one mission a name is its own. The kind is this list's alone.
 */
function instrumentsOf(listed: string, carried: readonly Detail[]): SatelliteInstrument[] {
  const instruments: SatelliteInstrument[] = [];
  for (const entry of listed.split("|")) {
    const [name, type, , technology] = entry.split("~").map((field) => field.trim());
    if (name === undefined || name === "") {
      continue;
    }
    const kind = technology || type;
    const detail = carried.find((candidate) => candidate.name === name);
    instruments.push({ name, ...(detail?.fullName !== undefined && { fullName: detail.fullName }), ...(kind && { kind }), ...detail?.figures });
  }
  return instruments;
}

/**
 * Keyed by normalized satnum: the missions with a NORAD id and at least one instrument,
 * each instrument with what the instrument list and the wavebands say of it. Throws on a
 * body that is not the assembled file, or holds one page of the missions, so it is not
 * stored and the stored file stands.
 */
export function parseCeos(body: string): CeosRows {
  let file: { missions?: { missions?: unknown; pagination?: Entry }; instruments?: { instruments?: unknown }; combinations?: { combinations?: unknown }; wavebands?: unknown };
  try {
    file = JSON.parse(body);
  } catch {
    throw new Error(`not JSON (got ${JSON.stringify(body.slice(0, 120))})`);
  }
  const missions = listOf(file?.missions?.missions, "missions");
  const pagination = file.missions?.pagination;
  if (pagination?.has_more === true) {
    throw new Error(`one page of the missions: ${String(pagination.returned)} of ${String(pagination.total)}`);
  }
  const details = instrumentDetails(listOf(file.instruments?.instruments, "instruments"), listOf(file.wavebands, "wavebands"));
  const carried = new Map<unknown, unknown[]>();
  for (const { mission_id: mission, instrument_id: instrument } of listOf(file.combinations?.combinations, "combinations")) {
    carried.set(mission, [...(carried.get(mission) ?? []), instrument]);
  }

  const rows: CeosRows = {};
  for (const { mission_id: id, norad_id: noradId, mission_acronym: name, launch_date: launchDate, status, instrument_details: listed } of missions) {
    // 0 is CEOS's "none": a planned mission, or one it has no id for.
    if (typeof noradId !== "number" || noradId <= 0 || typeof launchDate !== "string" || Number.isNaN(Date.parse(launchDate)) || typeof listed !== "string") {
      continue;
    }
    const instruments = instrumentsOf(
      listed,
      (carried.get(id) ?? []).flatMap((instrument) => details.get(instrument) ?? []),
    );
    if (instruments.length === 0) {
      continue;
    }
    const row: CeosMission = {
      name: typeof name === "string" ? name : "",
      launchDate,
      ...(!(typeof status === "string" && OPERATING.test(status)) && { retired: true as const }),
      instruments,
    };
    (rows[normalizeSatnumKey(String(noradId))] ??= []).push(row);
  }
  if (Object.keys(rows).length === 0) {
    throw new Error("no records");
  }
  for (const list of Object.values(rows)) {
    list.sort((a, b) => a.launchDate.localeCompare(b.launchDate));
  }
  return rows;
}

/**
 * The satellite table's CEOS bags: each satellite's instruments, across its missions.
 *
 * CEOS gives a constellation one mission and one unit's NORAD id, so the id alone would
 * hand BlackSky's 2016 mission to a satellite launched in 2026. A mission is kept only
 * where SATCAT says the satellite was up by its launch: a hosted payload launches after
 * its host, a constellation before its later units. Without SATCAT's date nothing is
 * claimed.
 *
 * A name several missions give counts once, retired only if every mission that gives it
 * is. The instruments still flown come first.
 */
export function ceosBags(ceos: CeosRows | undefined, satcat: Readonly<Record<string, Record<string, unknown>>> | undefined): Record<string, Record<string, unknown>> {
  const bags: Record<string, Record<string, unknown>> = {};
  for (const [satnum, missions] of Object.entries(ceos ?? {})) {
    const launched = satcat?.[satnum]?.launchDate;
    if (typeof launched !== "string") {
      continue;
    }
    const earliest = Date.parse(launched) - LAUNCH_SLACK_DAYS * 86_400_000;
    const byName = new Map<string, SatelliteInstrument>();
    for (const mission of missions) {
      if (!(Date.parse(mission.launchDate) >= earliest)) {
        continue;
      }
      for (const instrument of mission.instruments) {
        const seen = byName.get(instrument.name);
        if (seen === undefined || (seen.retired && !mission.retired)) {
          byName.set(instrument.name, { ...instrument, ...(mission.retired && { retired: true as const }) });
        }
      }
    }
    if (byName.size > 0) {
      const instruments = [...byName.values()];
      bags[satnum] = { instruments: [...instruments.filter(({ retired }) => !retired), ...instruments.filter(({ retired }) => retired)] };
    }
  }
  return bags;
}

/** The missions, their instruments and the wavebands, as one file: one row per NORAD id CEOS names. */
export const CEOS: UpstreamSpec<CeosRows> = {
  name: "ceos",
  url: CEOS_META_URL,
  assemble: assembleCeos,
  parse: parseCeos,
  timeoutMs: 60_000,
  // An annual agency survey, with corrections between; push-catalog checks daily.
  staleAfterMs: 10 * 24 * 3600_000,
};
