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

/** Lenient: a field of the wrong shape is dropped, so an older index still reads. */
function parsePreset(raw: unknown): GpPreset | undefined {
  if (!isObject(raw) || !Array.isArray(raw.groups)) {
    return undefined;
  }
  const groups = raw.groups.filter((group): group is GpPreset["groups"][number] => isObject(group) && typeof group.name === "string");
  const defaults = isObject(raw.defaults) ? Object.fromEntries(Object.entries(raw.defaults).filter(([, value]) => typeof value === "string")) : undefined;
  return {
    groups,
    ...(typeof raw.title === "string" && { title: raw.title }),
    ...(typeof raw.description === "string" && { description: raw.description }),
    ...(defaults && { defaults: defaults as Record<string, string> }),
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

/**
 * A bare group name resolves against the probed base; any other source (a legacy
 * .txt URL, a path) passes through unchanged and is sniffed by parseGpPayload.
 */
function resolveGroupUrl(source: string, base: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(source)) {
    return `${base}${source}.json`;
  }
  return source;
}

/** Undefined for an explicit URL source, which has no static counterpart. */
function staticGroupUrl(source: string): string | undefined {
  if (/^[a-zA-Z0-9_-]+$/.test(source)) {
    return `${STATIC_BASE}${source}.json`;
  }
  return undefined;
}

/** Never rejects: empty when neither the worker nor the static snapshot answers. */
export async function fetchGpIndex(): Promise<GpIndex> {
  return (await resolveGpSource()).index;
}

/**
 * A bare group name that fails against the worker is retried once against the
 * static snapshot. An explicit URL source has no fallback.
 */
export async function fetchGpGroup(source: string): Promise<string> {
  const { base } = await resolveGpSource();
  const url = resolveGroupUrl(source, base);
  try {
    // Not mode:"no-cors": an opaque response has an unreadable body.
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(response.statusText);
    }
    return await response.text();
  } catch (error) {
    const fallback = staticGroupUrl(source);
    if (fallback === undefined || fallback === url) {
      throw error;
    }
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
