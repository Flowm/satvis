// Keeps the url in step with stores that opt in via `urlsync`. Encoding lives in
// ./urlCodec; this adapter owns the router and history entries. Contract:
// docs/adr/0001-url-parameter-specification.md.

import type { PiniaPluginContext, Store as PiniaStore } from "pinia";
import { watch } from "vue";
import type { LocationQuery, Router } from "vue-router";

import { sameValue } from "./equality";
import { decode, encode, type FieldSpec, paramOf, type Query } from "./urlCodec";

export type { FieldKind, FieldSpec } from "./urlCodec";

interface UrlSyncConfig {
  enabled?: boolean;
  config: FieldSpec[];
  // Stores with guarded keys supply this so the url goes through their actions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply?: (store: any, patch: Record<string, unknown>) => void;
}

declare module "pinia" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export interface DefineStoreOptionsBase<S, Store> {
    urlsync?: UrlSyncConfig;
  }
}

// Injected by the plugin registered ahead of this one in src/app.ts.
interface ExtendedStore extends PiniaStore {
  router: Router;
  // The route's preset, as url parameters.
  presetDefaults?: Promise<Query>;
  [key: string]: unknown;
}

interface Registration {
  store: ExtendedStore;
  specs: FieldSpec[];
  apply: UrlSyncConfig["apply"];
  // Qualified with the store id, so two stores can share a key name.
  qualified: FieldSpec[];
  // Preset-merged values captured at hydration. Undefined until then, which
  // keeps this store's parameters from being rewritten.
  defaults?: Record<string, unknown>;
  // Keyed by qualified name; see `adjustUrlDefault`.
  adjust: Map<string, (baseline: unknown) => unknown>;
  // The opening link's spelling, before normalisation. Cleared by the first push.
  arrival?: Query;
}

// Every synced store, so one write can rebuild the whole query.
const registry = new Map<string, Registration>();
let watching = false;

const CLOCK_PARAM = "time";

let arrivedAt: string | undefined;

const qualify = (storeId: string, specs: FieldSpec[]): FieldSpec[] => specs.map((spec) => ({ ...spec, name: `${storeId}.${spec.name}` }));
const hydratedEntries = () => [...registry.values()].filter((entry) => entry.defaults !== undefined);

// Lossy on purpose; apply it only to owned parameters, so a valueless `?embed`
// or a repeated foreign parameter survives.
function normalizeQuery(query: LocationQuery, owned?: ReadonlySet<string>): Query {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (owned !== undefined && !owned.has(key)) {
      continue;
    }
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") {
      normalized[key] = first;
    }
  }
  return normalized;
}

const stableQuery = (query: LocationQuery): string =>
  JSON.stringify(
    Object.keys(query)
      .toSorted()
      .map((key) => [key, query[key]]),
  );

const withoutClock = (query: LocationQuery): string => {
  const { [CLOCK_PARAM]: _clock, ...rest } = query;
  return stableQuery(rest);
};

// Guarded keys are read-only computeds: assigning one does nothing but warn.
function commit(entry: Registration, patch: Record<string, unknown>): void {
  if (entry.apply) {
    entry.apply(entry.store, patch);
    return;
  }
  Object.assign(entry.store, patch);
}

function baseline(entry: Registration): Record<string, unknown> {
  const defaults = { ...entry.defaults };
  for (const [name, adjust] of entry.adjust) {
    if (name in defaults) {
      defaults[name] = adjust(defaults[name]);
    }
  }
  return defaults;
}

function applyQuery(entry: Registration, query: Query, defaults: Record<string, unknown> = baseline(entry), origin = "url parameter"): void {
  const { patch, invalid } = decode(query, entry.qualified, defaults);

  // decode returns fresh arrays every time, so a blind apply would churn.
  const next: Record<string, unknown> = {};
  let changed = false;
  for (const [index, spec] of entry.specs.entries()) {
    const value = patch[entry.qualified[index]!.name];
    next[spec.name] = value;
    if (!sameValue(entry.store[spec.name], value)) {
      changed = true;
    }
  }

  if (changed) {
    commit(entry, next);
  }

  for (const param of invalid) {
    console.warn(`Ignoring invalid ${origin}: ${param}`);
  }
}

// Parameters of stores not yet hydrated count as foreign and are preserved, so a
// late store still reads its url.
function buildQuery(router: Router, hydrated: Registration[]): LocationQuery {
  const current = router.currentRoute.value.query;
  const owned = new Set(hydrated.flatMap((entry) => entry.specs.map(paramOf)));

  const state: Record<string, unknown> = {};
  const defaults: Record<string, unknown> = {};
  const schema: FieldSpec[] = [];
  for (const entry of hydrated) {
    for (const [index, spec] of entry.specs.entries()) {
      const qualified = entry.qualified[index]!;
      state[qualified.name] = entry.store[spec.name];
      schema.push(qualified);
    }
    Object.assign(defaults, baseline(entry));
  }

  const next: LocationQuery = {};
  for (const [param, value] of Object.entries(current)) {
    if (!owned.has(param)) {
      next[param] = value;
    }
  }
  Object.assign(next, encode(state, defaults, schema));
  return next;
}

function writeQuery(router: Router, mode: "push" | "replace"): void {
  const hydrated = hydratedEntries();
  if (hydrated.length === 0) {
    return;
  }

  const current = router.currentRoute.value.query;
  const next = buildQuery(router, hydrated);

  // Also stops a push echoing back through the query watcher.
  if (stableQuery(next) === stableQuery(current)) {
    return;
  }
  const moved = [...new Set([...Object.keys(current), ...Object.keys(next)])].filter((param) => JSON.stringify(current[param]) !== JSON.stringify(next[param]));
  // A pinned clock rewrites `time` every minute, so a clock-only change replaces
  // rather than pushes. Pinning by scrubbing is then not separately undoable.
  const clockOnly = moved.every((param) => param === CLOCK_PARAM);
  // Compared with `arrivedAt`, not `current`: hydration's own store writes push
  // the url it is still replacing to.
  if (!clockOnly && mode === "push" && withoutClock(next) !== arrivedAt) {
    for (const entry of registry.values()) {
      entry.arrival = undefined;
    }
  }
  void router[clockOnly ? "replace" : mode]({ query: next }).catch(() => {
    // A redundant navigation is not an error.
  });
}

// Back and forward change the query without touching the stores.
function watchQuery(router: Router): void {
  if (watching) {
    return;
  }
  watching = true;
  watch(
    () => router.currentRoute.value.query,
    (query) => {
      for (const entry of hydratedEntries()) {
        applyQuery(entry, normalizeQuery(query, new Set(entry.specs.map(paramOf))));
      }
    },
  );
}

function snapshot(entry: Registration): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [index, spec] of entry.specs.entries()) {
    values[entry.qualified[index]!.name] = entry.store[spec.name];
  }
  return values;
}

function hydrate(entry: Registration, router: Router, presetDefaults: Query): void {
  // Preset defaults are url parameters: decode them before capturing defaults and reading the url.
  applyQuery(entry, presetDefaults, snapshot(entry), "preset default");
  entry.defaults = snapshot(entry);

  entry.arrival = normalizeQuery(router.currentRoute.value.query, new Set(entry.specs.map(paramOf)));
  applyQuery(entry, entry.arrival);
  arrivedAt = withoutClock(buildQuery(router, hydratedEntries()));

  // Drops invalid and default-valued parameters. Replace: arriving is not a state change.
  writeQuery(router, "replace");
  watchQuery(router);
}

function createUrlSync({ options, store }: PiniaPluginContext): void {
  const urlsync = options.urlsync;
  if (!urlsync?.enabled && !urlsync?.config) {
    return;
  }

  const extended = store as unknown as ExtendedStore;
  const { router } = extended;
  const entry: Registration = {
    store: extended,
    specs: urlsync.config,
    apply: urlsync.apply,
    qualified: qualify(store.$id, urlsync.config),
    adjust: new Map(),
  };
  registry.set(store.$id, entry);

  void Promise.all([router.isReady(), extended.presetDefaults ?? {}]).then(([, presetDefaults]) => hydrate(entry, router, presetDefaults));

  // Not $subscribe: guarded keys are computeds over private refs outside $state,
  // so $subscribe never sees them change.
  watch(
    () => entry.specs.map((spec) => extended[spec.name]),
    () => {
      if (entry.defaults === undefined) {
        return;
      }
      writeQuery(router, "push");
    },
    { deep: true },
  );
}

/**
 * `param` as the opening link spelled it, even if hydration dropped it as a
 * default. Undefined if the link did not name it, or once a change was pushed.
 */
export function arrivalParam(param: string): string | undefined {
  for (const entry of registry.values()) {
    if (entry.specs.some((spec) => paramOf(spec) === param)) {
      return entry.arrival?.[param];
    }
  }
  return undefined;
}

/** Derive one parameter's default from its route default; `undefined` restores the route default. */
export function adjustUrlDefault(storeId: string, key: string, adjust: ((baseline: unknown) => unknown) | undefined): void {
  const entry = registry.get(storeId);
  if (!entry) {
    return;
  }
  const name = `${storeId}.${key}`;
  if (adjust) {
    entry.adjust.set(name, adjust);
  } else {
    entry.adjust.delete(name);
  }
  writeQuery(entry.store.router, "replace");
}

export default createUrlSync;
