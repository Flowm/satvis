// URL <-> state codec implementing docs/adr/0001-url-parameter-specification.md;
// read it before changing the legacy read shims. Keep this free of Cesium, pinia,
// vue-router and the DOM so node-env vitest can test it.

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import { formatLayer, parseLayer } from "../../config/layers";
import type { SerializedGroundStation } from "../../stores/sat";

dayjs.extend(utc);

// `ok: false` means unrepresentable; the caller decides whether that costs an
// element or the whole parameter.
export type Result<T> = { ok: true; value: T } | { ok: false };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const FAIL: Result<never> = { ok: false };

export interface FieldKind<T> {
  // `raw` is already percent-decoded and "+"-expanded.
  parse(raw: string): Result<T>;
  format(value: T): Result<string>;
}

export interface FieldSpec {
  name: string;
  // Defaults to `name`.
  url?: string;
  // Method-syntax members are bivariant, so any FieldKind<T> lands here.
  kind: FieldKind<unknown>;
}

/** Unvalidated, for an open vocabulary with no delimiter (`track`). */
export function plainString(): FieldKind<string> {
  return {
    parse: (raw) => ok(raw),
    format: (value) => (typeof value === "string" ? ok(value) : FAIL),
  };
}

/** Rejects on parse, so `?terrain=Garbage` cannot diverge from the state. */
export function enumString(values: readonly string[]): FieldKind<string> {
  const member = (v: unknown): v is string => typeof v === "string" && values.includes(v);
  return {
    parse: (raw) => (member(raw) ? ok(raw) : FAIL),
    format: (value) => (member(value) ? ok(value) : FAIL),
  };
}

/** Only `true` and `false`, so `?fps=false` cannot read as truthy. */
export function boolean(): FieldKind<boolean> {
  return {
    parse: (raw) => (raw === "true" ? ok(true) : raw === "false" ? ok(false) : FAIL),
    format: (value) => (typeof value === "boolean" ? ok(String(value)) : FAIL),
  };
}

const LIST_SEPARATOR = ",";

function splitList(raw: string): string[] {
  return raw.split(LIST_SEPARATOR).filter((entry) => entry !== "");
}

function formatList(value: unknown): Result<string> {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return FAIL;
  }
  // URLSearchParams decodes %2C before the split, so a member containing a comma
  // is unrepresentable. Refuse it rather than emit a URL that reads back as two.
  if ((value as string[]).some((entry) => entry.includes(LIST_SEPARATOR))) {
    return FAIL;
  }
  return ok((value as string[]).join(LIST_SEPARATOR));
}

/** Spaces need no escaping: URLSearchParams and vue-router both round-trip them as "+". */
export function stringList(): FieldKind<string[]> {
  return { parse: (raw) => ok(splitList(raw)), format: formatList };
}

/**
 * `sats` / `xsats`. Legacy read shim for "~" as a space, applied unconditionally
 * because satellite names are an open vocabulary; a literal "~" is unrepresentable.
 */
export function tildeEscapedStringList(): FieldKind<string[]> {
  return {
    parse: (raw) => ok(splitList(raw).map((entry) => entry.replaceAll("~", " "))),
    format: (value) => {
      if (Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.includes("~"))) {
        return FAIL;
      }
      return formatList(value);
    },
  };
}

/**
 * An unusable member costs only that element. When every member is unusable the
 * whole parameter fails and the default stands, because an empty list is a
 * deliberate state of its own. An empty value still parses to the empty list.
 */
function resolveList(raw: string, resolve: (entry: string) => string | undefined): Result<string[]> {
  const entries = splitList(raw);
  const resolved = entries.flatMap((entry) => {
    const member = resolve(entry);
    return member === undefined ? [] : [member];
  });
  return entries.length > 0 && resolved.length === 0 ? FAIL : ok(resolved);
}

/**
 * `elements`. Legacy "-" space escape, resolved by membership: the literal is tried
 * first, so a component name can contain a hyphen.
 */
export function closedStringList(members: () => readonly string[]): FieldKind<string[]> {
  const resolve = (entry: string, known: readonly string[]): string | undefined => {
    if (known.includes(entry)) {
      return entry;
    }
    const unescaped = entry.replaceAll("-", " ");
    return known.includes(unescaped) ? unescaped : undefined;
  };
  return {
    parse: (raw) => {
      const known = members();
      return resolveList(raw, (entry) => resolve(entry, known));
    },
    format: (value) => {
      const known = members();
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !known.includes(entry))) {
        return FAIL;
      }
      return formatList(value);
    },
  };
}

/**
 * `layers`. Each item is a provider with an optional "_<alpha>" opacity suffix. The
 * "at most one base layer" rule lives in the store.
 */
export function layerList(providers: () => readonly string[]): FieldKind<string[]> {
  // An unusable alpha would reach Cesium as NaN and render nothing.
  const usable = (entry: string, names: readonly string[]): string | undefined => {
    const selection = parseLayer(entry);
    return selection !== undefined && names.includes(selection.provider) ? formatLayer(selection) : undefined;
  };
  return {
    parse: (raw) => {
      const names = providers();
      return resolveList(raw, (entry) => usable(entry, names));
    },
    format: (value) => {
      const names = providers();
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || usable(entry, names) === undefined)) {
        return FAIL;
      }
      return formatList(value);
    },
  };
}

const STATION_SEPARATOR = "_";
const COORDINATE_PRECISION = 4;

/**
 * `gs`. "_"-joined stations, each "lat,lon" or "lat,lon,name". A malformed station
 * costs only itself, so no NaN coordinates reach the store.
 */
export function groundStationList(): FieldKind<SerializedGroundStation[]> {
  return {
    parse: (raw) =>
      ok(
        raw
          .split(STATION_SEPARATOR)
          .filter((entry) => entry !== "")
          .flatMap((entry) => {
            const parts = entry.split(LIST_SEPARATOR);
            if (parts.length < 2 || parts.length > 3) {
              return [];
            }
            const lat = Number.parseFloat(parts[0] ?? "");
            const lon = Number.parseFloat(parts[1] ?? "");
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
              return [];
            }
            const name = parts[2];
            return [name === undefined || name === "" ? { lat, lon } : { lat, lon, name }];
          }),
      ),
    format: (value) => {
      if (!Array.isArray(value)) {
        return FAIL;
      }
      const parts: string[] = [];
      for (const station of value as SerializedGroundStation[]) {
        if (!Number.isFinite(station?.lat) || !Number.isFinite(station?.lon)) {
          return FAIL;
        }
        const name = station.name;
        // A name carrying either separator is unrepresentable.
        if (name !== undefined && (name.includes(LIST_SEPARATOR) || name.includes(STATION_SEPARATOR))) {
          return FAIL;
        }
        const coordinates = `${station.lat.toFixed(COORDINATE_PRECISION)},${station.lon.toFixed(COORDINATE_PRECISION)}`;
        parts.push(name ? `${coordinates},${name}` : coordinates);
      }
      return ok(parts.join(STATION_SEPARATOR));
    },
  };
}

const MINUTE_ISO = "YYYY-MM-DDTHH:mm[Z]";

/** Rounds to the minute; undefined if `value` is not a time. The only place the wire form is spelled out. */
export function toMinuteIso(value: string | Date): string | undefined {
  // dayjs accepts strings like "Point", so gate on Date.parse first.
  if (typeof value === "string" && Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  const parsed = dayjs.utc(value);
  return parsed.isValid() ? parsed.format(MINUTE_ISO) : undefined;
}

/**
 * `time`. Minute precision out, anything parseable in. `null` means the clock is
 * live: formatting it fails, which drops the parameter.
 */
export function timestamp(): FieldKind<string | null> {
  const round = (value: unknown) => (typeof value === "string" ? toMinuteIso(value) : undefined);
  return {
    parse: (raw) => {
      const rounded = toMinuteIso(raw);
      return rounded === undefined ? FAIL : ok(rounded);
    },
    format: (value) => {
      const rounded = round(value);
      return rounded === undefined ? FAIL : ok(rounded);
    },
  };
}

export type Query = Readonly<Record<string, string | undefined>>;

export interface DecodeResult {
  // Every schema key, so an absent parameter resets its state to the default.
  patch: Record<string, unknown>;
  // Parameters that were present but unusable; the caller drops them from the url.
  invalid: string[];
}

export const paramOf = (spec: FieldSpec): string => spec.url ?? spec.name;

/** `defaults` are the preset-merged store values, which only the caller knows. */
export function decode(query: Query, schema: readonly FieldSpec[], defaults: Readonly<Record<string, unknown>>): DecodeResult {
  const patch: Record<string, unknown> = {};
  const invalid: string[] = [];

  for (const spec of schema) {
    const param = paramOf(spec);
    const raw = query[param];
    if (raw === undefined) {
      patch[spec.name] = defaults[spec.name];
      continue;
    }
    const parsed = (spec.kind as FieldKind<unknown>).parse(raw);
    if (!parsed.ok) {
      patch[spec.name] = defaults[spec.name];
      invalid.push(param);
      continue;
    }
    patch[spec.name] = parsed.value;
  }

  return { patch, invalid };
}

/**
 * Only the parameters this codec owns; the router serializes them. Foreign ones
 * stay with the adapter, whose query type can hold a valueless or repeated parameter.
 */
export function encode(state: Readonly<Record<string, unknown>>, defaults: Readonly<Record<string, unknown>>, schema: readonly FieldSpec[]): Record<string, string> {
  const params: Record<string, string> = {};

  for (const spec of schema) {
    const param = paramOf(spec);
    const kind = spec.kind as FieldKind<unknown>;
    const formatted = kind.format(state[spec.name]);
    if (!formatted.ok) {
      // Leave it out rather than emit something that reads back differently.
      delete params[param];
      continue;
    }
    const fallback = kind.format(defaults[spec.name]);
    if (fallback.ok && fallback.value === formatted.value) {
      delete params[param];
      continue;
    }
    params[param] = formatted.value;
  }

  return params;
}
