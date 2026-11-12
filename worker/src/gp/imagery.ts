// The imagery manifest (ADR 0019), apart from generate-groups.mjs so the worker tests reach it.

import type { ImageryEntry, SatelliteImagery } from "./types.ts";

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

const TILE_FORMATS: readonly string[] = ["png", "jpeg"];

const ENTRY_KEYS = new Set<string>(["provider", "layer", "label", "kind", ...OPTIONAL_FIELDS.map(({ key }) => key), "merged", "maxLevel", "format"]);

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
  checkKeys(entry, ENTRY_KEYS, where);
  const { provider, layer, label, kind, merged, maxLevel, format } = entry;
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
  if (merged !== undefined && merged !== true) {
    throw new Error(`${where}: "merged" is true or absent`);
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
  const tiles = maxLevel === undefined ? undefined : { maxLevel: maxLevel as number, format: format as "png" | "jpeg" };
  return { provider, layer, label, kind, ...fields, ...(merged === true && { merged }), ...tiles };
}

/**
 * NORAD id -> its imagery, in manifest order, so an instrument's first entry is the
 * first one listed for it. `origin` is where the manifest is, for the errors.
 *
 * Fails, naming both places, on a provider's layer listed twice for one satellite's
 * instrument, as two models for one satellite do, and on one listed under several
 * satellites unless each says `merged`: a copied entry reads as a shared layer otherwise.
 */
export function imageryBySatellite(manifest: unknown, origin: string): Map<number, SatelliteImagery[]> {
  const bySatellite = new Map<number, SatelliteImagery[]>();
  const claimed = new Map<string, string>();
  // provider and layer -> each place it is listed.
  const listings = new Map<string, { noradId: number; merged: boolean; where: string }[]>();

  if (!isObject(manifest)) {
    throw new Error(`${origin}: expected "satellites" at the top level`);
  }
  checkKeys(manifest, new Set(["satellites"]), origin);
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
        const claim = JSON.stringify([noradId, instrument, fields.provider, fields.layer]);
        const previous = claimed.get(claim);
        if (previous !== undefined) {
          throw new Error(`${here}: ${fields.provider} ${fields.layer} already shows ${instrument} of noradId ${noradId} in ${previous}`);
        }
        claimed.set(claim, here);

        const layer = JSON.stringify([fields.provider, fields.layer]);
        const listing = { noradId, merged: fields.merged === true, where: here };
        const others = listings.get(layer);
        if (others === undefined) {
          listings.set(layer, [listing]);
        } else {
          others.push(listing);
        }

        const entry: SatelliteImagery = { instrument, ...fields };
        const list = bySatellite.get(noradId);
        if (list === undefined) {
          bySatellite.set(noradId, [entry]);
        } else {
          list.push(entry);
        }
      });
    }
  });

  for (const places of listings.values()) {
    const first = places[0]!;
    const elsewhere = places.find(({ noradId }) => noradId !== first.noradId);
    const unmarked = places.find(({ merged }) => !merged);
    if (elsewhere !== undefined && unmarked !== undefined) {
      const other = unmarked === first ? elsewhere : first;
      throw new Error(`${unmarked.where}: its layer is also listed in ${other.where}; a layer that shows several satellites says "merged: true" under each`);
    }
    const marked = places.find(({ merged }) => merged);
    if (elsewhere === undefined && marked !== undefined) {
      throw new Error(`${marked.where}: "merged" is for a layer listed under several satellites`);
    }
  }
  return bySatellite;
}
