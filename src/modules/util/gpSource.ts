// Where GP data comes from: the worker API if `/api/groups.json` answers JSON
// (probed once per session), else the static `data/gp/` snapshot from `pnpm update-gp`.

const API_BASE = "/api/gp/";
const STATIC_BASE = "data/gp/";
const PROBE_URL = "/api/groups.json";
const STATIC_INDEX_URL = "data/gp/index.json";
const PROBE_TIMEOUT_MS = 3000;

/** `/api/groups.json` and `data/gp/index.json` share this shape. */
export interface GpIndexEntry {
  name: string;
  updated?: string;
  count?: number;
  tags?: string[];
}

/** worker/src/gp/types.ts PresetDefinition. `defaults` are url parameters. */
export interface GpPreset {
  title?: string;
  description?: string;
  defaults?: Record<string, string>;
  groups: { name: string; searchOnly?: boolean }[];
  /** Links against `defaults`, each with its card's picture as a path on the site. */
  featured?: { name: string; thumbnail: string; query: Record<string, string> }[];
  /** The scenes the benchmark measures on this route, the default preset's where it lists none. */
  benchmark?: BenchmarkScene[];
}

/** worker/src/gp/types.ts BenchmarkScene (ADR 0016). */
export interface BenchmarkScene {
  /** Names the scene's fields in a report. */
  id: string;
  name: string;
  /** The path it opens on, which need not be the route it was served for. */
  route: string;
  query: Record<string, string>;
  paced: boolean;
}

export interface GpIndex {
  groups: GpIndexEntry[];
  presets: Record<string, GpPreset>;
}

interface GpSourceInfo {
  base: string;
  index: GpIndex;
}

const EMPTY_INDEX: GpIndex = { groups: [], presets: {} };

let infoPromise: Promise<GpSourceInfo> | undefined;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Url parameters without the values that are not strings. */
const stringValues = (raw: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

/** Lenient: a field or featured bookmark of the wrong shape is dropped, so an older index still reads. */
function parsePreset(raw: unknown): GpPreset | undefined {
  if (!isObject(raw) || !Array.isArray(raw.groups)) {
    return undefined;
  }
  const groups = raw.groups.filter((group): group is GpPreset["groups"][number] => isObject(group) && typeof group.name === "string");
  const featured = Array.isArray(raw.featured)
    ? raw.featured.flatMap((entry: unknown) =>
        isObject(entry) && typeof entry.name === "string" && typeof entry.thumbnail === "string"
          ? [{ name: entry.name, thumbnail: entry.thumbnail, query: isObject(entry.query) ? stringValues(entry.query) : {} }]
          : [],
      )
    : undefined;
  const benchmark = Array.isArray(raw.benchmark)
    ? raw.benchmark.flatMap((entry: unknown): BenchmarkScene[] =>
        isObject(entry) && typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.route === "string"
          ? [{ id: entry.id, name: entry.name, route: entry.route, query: isObject(entry.query) ? stringValues(entry.query) : {}, paced: entry.paced === true }]
          : [],
      )
    : undefined;
  return {
    groups,
    ...(typeof raw.title === "string" && { title: raw.title }),
    ...(typeof raw.description === "string" && { description: raw.description }),
    ...(isObject(raw.defaults) && { defaults: stringValues(raw.defaults) }),
    ...(featured && { featured }),
    ...(benchmark && { benchmark }),
  };
}

function parseIndex(payload: unknown): GpIndex {
  if (!isObject(payload) || !Array.isArray(payload.groups)) {
    return EMPTY_INDEX;
  }
  const groups: GpIndexEntry[] = [];
  for (const raw of payload.groups) {
    if (!isObject(raw) || typeof raw.name !== "string") {
      continue;
    }
    const { tags, ...group } = raw as unknown as GpIndexEntry;
    groups.push(isStringArray(tags) ? Object.assign(group, { tags }) : group);
  }
  const presets: Record<string, GpPreset> = {};
  if (isObject(payload.presets)) {
    for (const [name, raw] of Object.entries(payload.presets)) {
      const preset = parsePreset(raw);
      if (preset) {
        presets[name] = preset;
      }
    }
  }
  return { groups, presets };
}

async function fetchStaticIndex(): Promise<GpIndex> {
  try {
    const response = await fetch(STATIC_INDEX_URL);
    if (!response.ok) {
      return EMPTY_INDEX;
    }
    return parseIndex(await response.json());
  } catch {
    return EMPTY_INDEX;
  }
}

async function probeGpSource(): Promise<GpSourceInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(PROBE_URL, { signal: controller.signal });
    if (!response.ok) {
      return { base: STATIC_BASE, index: await fetchStaticIndex() };
    }
    // A worker-less deployment answers with index.html and a 200, so require a JSON body.
    const payload = (await response.json()) as unknown;
    return { base: API_BASE, index: parseIndex(payload) };
  } catch {
    return { base: STATIC_BASE, index: await fetchStaticIndex() };
  } finally {
    clearTimeout(timer);
  }
}

function resolveGpSource(): Promise<GpSourceInfo> {
  infoPromise ??= probeGpSource();
  return infoPromise;
}

/** Never rejects: empty when neither the worker nor the static snapshot answers. */
export async function fetchGpIndex(): Promise<GpIndex> {
  return (await resolveGpSource()).index;
}

/** A group that fails against the worker is retried once against the static snapshot. */
export async function fetchGpGroup(group: string): Promise<string> {
  const { base } = await resolveGpSource();
  const url = `${base}${group}.json`;
  try {
    // Not mode:"no-cors": an opaque response has an unreadable body.
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return await response.text();
  } catch (error) {
    if (base !== API_BASE) {
      throw error;
    }
    const fallback = `${STATIC_BASE}${group}.json`;
    console.log(`GP fetch failed for ${url}, retrying static snapshot ${fallback}`, error);
    const response = await fetch(fallback);
    if (!response.ok) {
      throw new Error(response.statusText, { cause: error });
    }
    return await response.text();
  }
}

/** Test seam: the probe is otherwise memoized for the life of the module. */
export function resetGpSource(): void {
  infoPromise = undefined;
}
