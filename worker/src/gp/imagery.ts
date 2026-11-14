// The imagery manifest (ADR 0019), apart from generate-groups.mjs so the worker tests reach it.

import type { ImageryEntry, SatelliteImagery, TileFormat } from "./types.ts";

type Raw = Record<string, unknown>;

const IMAGERY_KINDS: readonly string[] = ["rgb"];

/** A provider's name is a key of each app's provider table. */
const PROVIDER_RE = /^[a-z][a-z0-9-]*$/;
/** ISO 8601, without weeks: "P1D", "PT10M", "P90D". */
const DURATION_RE = /^P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

/** A day that exists, as "2026-11-02". */
function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const isDuration = (value: unknown) => typeof value === "string" && DURATION_RE.test(value);

/** An entry's optional text fields, in the order a record carries them, and what each must be. */
const OPTIONAL_FIELDS: readonly { key: "period" | "start" | "end" | "window"; is: (value: unknown) => boolean; expected: string }[] = [
  { key: "period", is: isDuration, expected: "an ISO 8601 duration" },
  { key: "start", is: isDate, expected: "an ISO date" },
  { key: "end", is: isDate, expected: "an ISO date" },
  { key: "window", is: isDuration, expected: "an ISO 8601 duration" },
];

/** Every TileFormat. */
const TILE_FORMATS: readonly string[] = ["png", "jpeg", "webp"] satisfies TileFormat[];

const ENTRY_KEYS = new Set<string>(["provider", "layer", "label", "kind", ...OPTIONAL_FIELDS.map(({ key }) => key), "maxLevel", "format"]);
const COMPOSITE_KEYS = new Set<string>([...ENTRY_KEYS, "satellites"]);
const MEMBER_KEYS = new Set<string>(["noradId", "name", "instrument", "start", "end"]);

function isObject(value: unknown): value is Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function checkKeys(value: Raw, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${where}: unknown key ${JSON.stringify(key)}`);
    }
  }
}

/** One entry of an instrument's list, checked. */
function imageryEntry(entry: unknown, where: string): ImageryEntry {
  if (!isObject(entry)) {
    throw new Error(`${where}: must be an object`);
  }
  if (entry.merged !== undefined) {
    throw new Error(`${where}: a layer that shows several satellites is a composite, listed once under "composites" with its satellites`);
  }
  checkKeys(entry, ENTRY_KEYS, where);
  const { provider, layer, label, kind, maxLevel, format } = entry;
  if (typeof provider !== "string" || !PROVIDER_RE.test(provider)) {
    throw new Error(`${where}: "provider" must be a lower-case name (got ${JSON.stringify(provider)})`);
  }
  if (!isText(layer)) {
    throw new Error(`${where}: "layer" must be the provider's id for it`);
  }
  if (!isText(label)) {
    throw new Error(`${where}: "label" must say what the picture is`);
  }
  if (typeof kind !== "string" || !IMAGERY_KINDS.includes(kind)) {
    throw new Error(`${where}: "kind" must be one of ${IMAGERY_KINDS.join(", ")} (got ${JSON.stringify(kind)})`);
  }
  const fields: Record<string, string> = {};
  for (const { key, is, expected } of OPTIONAL_FIELDS) {
    const value = entry[key];
    if (value === undefined) {
      continue;
    }
    if (!is(value)) {
      throw new Error(`${where}: "${key}" must be ${expected} (got ${JSON.stringify(value)})`);
    }
    fields[key] = value as string;
  }
  if (fields.window !== undefined && fields.start !== undefined) {
    throw new Error(`${where}: "window" and "start" exclude each other: a rolling history has no first frame`);
  }
  if ((maxLevel === undefined) !== (format === undefined)) {
    throw new Error(`${where}: "maxLevel" and "format" go together: an app draws the layer from both`);
  }
  if (maxLevel !== undefined && (typeof maxLevel !== "number" || !Number.isInteger(maxLevel) || maxLevel < 0 || maxLevel > 24)) {
    throw new Error(`${where}: "maxLevel" must be a tile level (got ${JSON.stringify(maxLevel)})`);
  }
  if (format !== undefined && (typeof format !== "string" || !TILE_FORMATS.includes(format))) {
    throw new Error(`${where}: "format" must be one of ${TILE_FORMATS.join(", ")} (got ${JSON.stringify(format)})`);
  }
  const tiles = maxLevel === undefined ? undefined : { maxLevel: maxLevel as number, format: format as ImageryEntry["format"] & string };
  return { provider, layer, label, kind, ...fields, ...tiles };
}

/**
 * NORAD id -> its imagery, in manifest order: a satellite's own entries, so an
 * instrument's first entry is the first one listed for it, then each composite's that
 * names it, `merged`. `origin` is where the manifest is, for the errors.
 *
 * Fails, naming both places, on a provider's layer listed twice for one satellite's
 * instrument, as two models for one satellite do, and on one listed in two places: under
 * two satellites, which is a composite, or as a composite and anywhere else.
 */
export function imageryBySatellite(manifest: unknown, origin: string): Map<number, SatelliteImagery[]> {
  const bySatellite = new Map<number, SatelliteImagery[]>();
  const claimed = new Map<string, string>();
  // provider and layer -> where it is listed first: a satellite's entry, or a composite.
  const listed = new Map<string, { noradId?: number; where: string }>();

  if (!isObject(manifest)) {
    throw new Error(`${origin}: expected "satellites" at the top level`);
  }
  checkKeys(manifest, new Set(["satellites", "composites"]), origin);

  // Gives the satellite the entry, refusing one that already shows its instrument.
  const add = (noradId: number, entry: SatelliteImagery, where: string) => {
    const claim = JSON.stringify([noradId, entry.instrument, entry.provider, entry.layer]);
    const previous = claimed.get(claim);
    if (previous !== undefined) {
      throw new Error(`${where}: ${entry.provider} ${entry.layer} already shows ${entry.instrument} of noradId ${noradId} in ${previous}`);
    }
    claimed.set(claim, where);
    const entries = bySatellite.get(noradId);
    if (entries === undefined) {
      bySatellite.set(noradId, [entry]);
    } else {
      entries.push(entry);
    }
  };
  // Records where the layer is listed, refusing a second place for it.
  const placeLayer = (fields: ImageryEntry, place: { noradId?: number; where: string }) => {
    const layer = JSON.stringify([fields.provider, fields.layer]);
    const first = listed.get(layer);
    if (first === undefined) {
      listed.set(layer, place);
    } else if (first.noradId === undefined || place.noradId === undefined || first.noradId !== place.noradId) {
      throw new Error(`${place.where}: its layer is also listed in ${first.where}; a layer that shows several satellites is one composite, under "composites"`);
    }
  };

  const satellites = manifest.satellites ?? [];
  if (!Array.isArray(satellites)) {
    throw new Error(`${origin}: "satellites" must be a list`);
  }
  satellites.forEach((satellite: unknown, i) => {
    const where = `${origin} satellites[${i}]`;
    if (!isObject(satellite) || !Number.isInteger(satellite.noradId)) {
      throw new Error(`${where}: needs a numeric "noradId"`);
    }
    checkKeys(satellite, new Set(["noradId", "name", "instruments"]), where);
    const noradId = satellite.noradId as number;
    const { instruments } = satellite;
    if (!isObject(instruments) || Object.keys(instruments).length === 0) {
      throw new Error(`${where}: "instruments" must map an instrument's name to its imagery`);
    }
    for (const [instrument, entries] of Object.entries(instruments)) {
      const at = `${where} ${JSON.stringify(instrument)}`;
      if (!isText(instrument) || !Array.isArray(entries) || entries.length === 0) {
        throw new Error(`${at}: must list at least one entry under the instrument's name`);
      }
      entries.forEach((raw: unknown, j) => {
        const here = `${at}[${j}]`;
        const fields = imageryEntry(raw, here);
        placeLayer(fields, { noradId, where: here });
        add(noradId, { instrument, ...fields }, here);
      });
    }
  });

  const composites = manifest.composites ?? [];
  if (!Array.isArray(composites)) {
    throw new Error(`${origin}: "composites" must be a list`);
  }
  composites.forEach((composite: unknown, i) => {
    const where = `${origin} composites[${i}]`;
    if (!isObject(composite)) {
      throw new Error(`${where}: must be an object`);
    }
    checkKeys(composite, COMPOSITE_KEYS, where);
    const { satellites: members, ...shared } = composite;
    if (!Array.isArray(members) || members.length < 2) {
      throw new Error(`${where}: "satellites" must list the two or more satellites it shows`);
    }
    placeLayer(imageryEntry(shared, where), { where });
    members.forEach((member: unknown, j) => {
      const here = `${where} satellites[${j}]`;
      if (!isObject(member) || !Number.isInteger(member.noradId) || !isText(member.instrument)) {
        throw new Error(`${here}: needs a numeric "noradId" and the "instrument" it shows`);
      }
      checkKeys(member, MEMBER_KEYS, here);
      const { noradId, instrument, start, end } = member as { noradId: number; instrument: string; start?: unknown; end?: unknown };
      // The satellite's own dates take the composite's place, as the frames that are its own.
      const fields = imageryEntry({ ...shared, ...(start !== undefined && { start }), ...(end !== undefined && { end }) }, here);
      add(noradId, { instrument, ...fields, merged: true }, here);
    });
  });
  return bySatellite;
}
