// CEOS's MIM database, a contributor to the satellite table (ADR 0018). CC BY 4.0,
// "CEOS MIM Database, https://database.eohandbook.com".

import { normalizeSatnumKey } from "./satnum.ts";
import type { CeosMission, CeosRows, SatelliteInstrument } from "./types.ts";
import type { UpstreamSpec } from "./upstream.ts";

/** A beta API, whose paths and fields may change. */
const CEOS_API = "https://ceos-capabilities.org/api";

/** The snapshot's version, which CEOS says to ask before downloading again. */
export const CEOS_META_URL = `${CEOS_API}/meta`;

/**
 * Each one answer: the missions (~1.9 MB, whole while no `limit` is sent), the
 * instruments (~0.6 MB), and which mission carries which (~0.4 MB).
 */
export const CEOS_LIST_URLS = { missions: `${CEOS_API}/missions`, instruments: `${CEOS_API}/instruments`, combinations: `${CEOS_API}/combinations` } as const;

/** The 17 wavebands; each one's instruments are a request of their own, ~2.1 MB in all. */
export const CEOS_WAVEBANDS_URL = `${CEOS_API}/wavebands`;

/** One waveband, with the instruments that sense in it. */
export const ceosWavebandUrl = (id: unknown): string => `${CEOS_API}/waveband/${String(id)}`;

/** The metadata keys CEOS owns; no other upstream table may write them (ADR 0008). */
export const CEOS_KEYS: readonly string[] = ["instruments"];

/** The fields the parser reads, by list; every entry must have them. */
const FIELDS = {
  missions: ["mission_id", "norad_id", "mission_acronym", "launch_date", "status", "instrument_details"],
  instruments: ["instrument_id", "name_short", "name_full", "spatial_resolution_best", "swath_width_max"],
  combinations: ["mission_id", "instrument_id"],
  wavebands: ["abbr", "instruments"],
} as const;

/** "N/A" and "Uncertain" do not retire: CEOS does not say the mission is over. */
const RETIRING_STATUS = /^(Mission complete|Cancelled)/;

/**
 * The two sources disagree by a day for 32 of the 302 matched missions, a launch near
 * midnight UTC; the nearest constellation is 266 days out.
 */
const LAUNCH_SLACK_DAYS = 1;

/** A datetime without a zone, which `Date.parse` would read as local time. */
const ZONELESS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

type Entry = Record<string, unknown>;

/** Days since 1970 of a date or datetime's calendar date in UTC; NaN for neither. */
function utcDay(text: string): number {
  return Math.floor(Date.parse(ZONELESS.test(text) ? `${text.replace(" ", "T")}Z` : text) / 86_400_000);
}

/** The hash is of the identifiers alone; the time says a snapshot was loaded, even one that changed none. */
function versionOf(meta: string): string {
  const { registry_version: hash, registry_generated_at: generated } = JSON.parse(meta) as { registry_version?: unknown; registry_generated_at?: unknown };
  if (typeof hash !== "string" || typeof generated !== "string") {
    throw new Error("no registry_version or registry_generated_at in /meta");
  }
  return `${hash}@${generated}`;
}

/** The stored file: each list as CEOS answered it, the wavebands in the order CEOS lists them. */
export function ceosFileOf(lists: { missions: string; instruments: string; combinations: string; wavebands: readonly string[] }): string {
  return `{"missions":${lists.missions},"instruments":${lists.instruments},"combinations":${lists.combinations},"wavebands":[${lists.wavebands.join(",")}]}`;
}

/** `etag` is the stored file's version. */
async function assembleCeos(get: (url: string) => Promise<string>, etag: string | undefined): Promise<{ body: string; etag: string } | undefined> {
  const version = versionOf(await get(CEOS_META_URL));
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
  const wavebands = await Promise.all(index.wavebands.map(({ waveband_id: id }) => get(ceosWavebandUrl(id))));
  if (versionOf(await get(CEOS_META_URL)) !== version) {
    throw new Error("the snapshot changed during the download");
  }
  return { body: ceosFileOf({ missions, instruments, combinations, wavebands }), etag: version };
}

/** A non-empty list each of whose entries has every field the parser reads of it. */
function listOf(list: unknown, name: keyof typeof FIELDS): Entry[] {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`no ${name} list`);
  }
  for (const entry of list) {
    for (const field of FIELDS[name]) {
      if (typeof entry !== "object" || entry === null || !(field in entry)) {
        throw new Error(`no ${field} field in ${name}`);
      }
    }
  }
  return list as Entry[];
}

/** CEOS writes null, or 0, for a figure it does not have. */
function figure(value: unknown, field: string): number | undefined {
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "number") {
    throw new Error(`${field} is not a number: ${JSON.stringify(value)}`);
  }
  return value > 0 ? value : undefined;
}

/** What the instrument list and the wavebands say of one instrument. */
interface InstrumentDetail {
  name: string;
  fullName?: string;
  figures: Pick<SatelliteInstrument, "bands" | "resolutionM" | "nominalSwathKm">;
}

/** By instrument id, the names trimmed: eight short names end in a space or a newline. */
function instrumentsById(instruments: Entry[], wavebands: Entry[]): Map<number, InstrumentDetail> {
  const bands = new Map<number, string[]>();
  for (const { abbr, instruments: tagged } of wavebands) {
    if (typeof abbr !== "string" || !Array.isArray(tagged)) {
      throw new Error("a waveband without its abbr or its instruments");
    }
    for (const entry of tagged as unknown[]) {
      const id = (entry as Entry | null)?.instrument_id;
      if (typeof id !== "number") {
        throw new Error(`no instrument_id in waveband ${abbr}`);
      }
      bands.set(id, [...(bands.get(id) ?? []), abbr]);
    }
  }
  const details = new Map<number, InstrumentDetail>();
  for (const { instrument_id: id, name_short: short, name_full: full, spatial_resolution_best: resolution, swath_width_max: swath } of instruments) {
    const resolutionM = figure(resolution, "spatial_resolution_best");
    const nominalSwathKm = figure(swath, "swath_width_max");
    if (typeof id !== "number" || typeof short !== "string") {
      continue;
    }
    const name = short.trim();
    const fullName = typeof full === "string" ? full.trim() : "";
    details.set(id, {
      name,
      ...(fullName !== "" && fullName !== name && { fullName }),
      figures: { ...(bands.has(id) && { bands: bands.get(id) }), ...(resolutionM !== undefined && { resolutionM }), ...(nominalSwathKm !== undefined && { nominalSwathKm }) },
    });
  }
  return details;
}

/**
 * `listed` is `instrument_details`: instruments joined with "|", each as
 * name~type~second type~technology~measurements. `carried` are the mission's
 * instruments by the combinations; within one mission a name is its own.
 */
function instrumentsOf(listed: string, carried: readonly InstrumentDetail[]): SatelliteInstrument[] {
  const instruments: SatelliteInstrument[] = [];
  for (const entry of listed === "" ? [] : listed.split("|")) {
    const fields = entry.split("~").map((field) => field.trim());
    if (fields.length < 4) {
      throw new Error(`instrument_details is not name~type~second type~technology: ${JSON.stringify(entry.slice(0, 80))}`);
    }
    const [name, type, , technology] = fields;
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
 * Keyed by normalized satnum: the missions with a NORAD id and at least one instrument.
 * Throws on a body that is not the assembled file, or not in the shape it had, so it is
 * not stored and the stored file stands.
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
  if (pagination?.has_more !== false) {
    throw new Error("no pagination.has_more in missions");
  }
  const details = instrumentsById(listOf(file.instruments?.instruments, "instruments"), listOf(file.wavebands, "wavebands"));
  const byMission = new Map<number, InstrumentDetail[]>();
  for (const { mission_id: mission, instrument_id: instrument } of listOf(file.combinations?.combinations, "combinations")) {
    const detail = typeof instrument === "number" ? details.get(instrument) : undefined;
    if (typeof mission === "number" && detail !== undefined) {
      byMission.set(mission, [...(byMission.get(mission) ?? []), detail]);
    }
  }

  const rows: CeosRows = {};
  for (const { mission_id: id, norad_id: noradId, mission_acronym: name, launch_date: launchDate, status, instrument_details: listed } of missions) {
    // 0 is CEOS's "none": a planned mission, or one it has no id for.
    if (typeof noradId !== "number" || noradId <= 0 || typeof launchDate !== "string" || Number.isNaN(utcDay(launchDate)) || typeof listed !== "string") {
      continue;
    }
    const instruments = instrumentsOf(listed, (typeof id === "number" ? byMission.get(id) : undefined) ?? []);
    if (instruments.length === 0) {
      continue;
    }
    const row: CeosMission = {
      name: typeof name === "string" ? name : "",
      launchDate,
      ...(typeof status === "string" && RETIRING_STATUS.test(status) && { retired: true as const }),
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
 * Each satellite's instruments, from the missions SATCAT's launch date confirms (ADR
 * 0018): a name several missions give counts once, retired only if every one of them is.
 */
export function ceosBags(ceos: CeosRows | undefined, satcat: Readonly<Record<string, Record<string, unknown>>> | undefined): Record<string, Record<string, unknown>> {
  const bags: Record<string, Record<string, unknown>> = {};
  for (const [satnum, missions] of Object.entries(ceos ?? {})) {
    const launched = satcat?.[satnum]?.launchDate;
    if (typeof launched !== "string") {
      continue;
    }
    const earliest = utcDay(launched) - LAUNCH_SLACK_DAYS;
    const byName = new Map<string, SatelliteInstrument>();
    for (const mission of missions) {
      if (!(utcDay(mission.launchDate) >= earliest)) {
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
  /** An annual agency survey, with corrections between; push-catalog checks daily. */
  staleAfterMs: 10 * 24 * 3600_000,
};
