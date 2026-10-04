// Keeps the url in step with the stores that opt in via their `urlsync`
// option. All the encoding lives in ./urlCodec; this module is the adapter
// that owns the impure parts — the router, and deciding what becomes a
// history entry.
//
// The contract is docs/adr/0001-url-parameter-specification.md.

import type { PiniaPluginContext, Store as PiniaStore } from "pinia";
import { watch } from "vue";
import type { LocationQuery, Router } from "vue-router";

import { sameValue } from "./equality";
import { decode, encode, type FieldSpec, paramOf, type Query } from "./urlCodec";

export type { FieldKind, FieldSpec } from "./urlCodec";

interface UrlSyncConfig {
  enabled?: boolean;
  config: FieldSpec[];
  // How a decoded patch reaches the store. Stores with guarded keys supply
  // this so the url goes through the same actions as every other writer;
  // without it each key is assigned directly.
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
  // The route's preset, as url parameters. Shared by every store; each decodes
  // the parameters it owns.
  presetDefaults?: Promise<Query>;
  [key: string]: unknown;
}

interface Registration {
  store: ExtendedStore;
  specs: FieldSpec[];
  apply: UrlSyncConfig["apply"];
  // Store keys are qualified with the store id so two stores can use the same
  // key name without colliding in the shared rebuild below.
  qualified: FieldSpec[];
  // Preset-merged values, captured at hydration. Undefined until then, which
  // is also how we know this store's parameters must not be rewritten yet.
  defaults?: Record<string, unknown>;
  // Applied over `defaults`, keyed by qualified name, for a baseline that
  // depends on more than the route (`adjustUrlDefault`).
  adjust: Map<string, (baseline: unknown) => unknown>;
  // This store's parameters as the opening link spelled them, before
  // hydration normalised them. Cleared by the first pushed change.
  arrival?: Query;
}

// Every synced store, so one write can rebuild the whole query. Without this
// the url is an integration channel between stores, each preserving the
// other's parameters by reading them back out of the current location.
const registry = new Map<string, Registration>();
let watching = false;

// The one parameter that changes without anyone asking it to.
const CLOCK_PARAM = "time";

// The query hydration normalised the opening link to, less the clock.
let arrivedAt: string | undefined;

const qualify = (storeId: string, specs: FieldSpec[]): FieldSpec[] => specs.map((spec) => ({ ...spec, name: `${storeId}.${spec.name}` }));
const hydratedEntries = () => [...registry.values()].filter((entry) => entry.defaults !== undefined);

// vue-router hands back string | null | (string | null)[]; the codec wants one
// string per parameter. Lossy on purpose, and only ever applied to parameters
// the codec owns — a foreign parameter keeps the router's own representation so
// that `?embed` (valueless) and repeated parameters survive untouched.
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

// Guarded keys are read-only computeds, so a store that has any must route
// writes through its actions. Assigning them directly would silently do
// nothing beyond a Vue warning.
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

// Values missing from the query fall back to `defaults`, which are the
// preset-merged ones once hydrated.
function applyQuery(entry: Registration, query: Query, defaults: Record<string, unknown> = baseline(entry), origin = "url parameter"): void {
  const { patch, invalid } = decode(query, entry.qualified, defaults);

  // Back to unqualified store keys, and note whether anything actually moved:
  // decode hands back fresh arrays every time, so a blind apply would churn.
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

// Rebuild the entire query from every hydrated store. Parameters belonging to
// stores that have not hydrated yet are treated as foreign and preserved, so a
// store created late cannot have its url read out from under it.
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

  // Parameters this codec does not own pass through with the value the router
  // gave us, so a valueless or repeated one is not flattened away.
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

  // A write that changes nothing is not a state change and must not become a
  // history entry. This is also what stops a push from echoing back through
  // the query watcher.
  if (stableQuery(next) === stableQuery(current)) {
    return;
  }
  const moved = [...new Set([...Object.keys(current), ...Object.keys(next)])].filter((param) => JSON.stringify(current[param]) !== JSON.stringify(next[param]));
  // A history entry stands for an intent, and a minute elapsing is not one.
  // While the clock is pinned it rewrites `time` every minute, so a change that
  // moves nothing else replaces rather than pushes. The cost is that pinning by
  // scrubbing is not separately undoable, which beats a history full of ticks.
  const clockOnly = moved.every((param) => param === CLOCK_PARAM);
  // Judged against where the link landed rather than against `current`:
  // hydration's own store writes push the url it is still replacing to.
  if (!clockOnly && mode === "push" && withoutClock(next) !== arrivedAt) {
    for (const entry of registry.values()) {
      entry.arrival = undefined;
    }
  }
  void router[clockOnly ? "replace" : mode]({ query: next }).catch(() => {
    // A redundant navigation is not an error worth surfacing.
  });
}

// Back and forward change the query without touching the store, so the url has
// to be re-applied. One watcher covers every store: the query is rebuilt whole,
// so it is never partially owned.
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

// The store's current values, keyed as the codec sees them.
function snapshot(entry: Registration): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [index, spec] of entry.specs.entries()) {
    values[entry.qualified[index]!.name] = entry.store[spec.name];
  }
  return values;
}

function hydrate(entry: Registration, router: Router, presetDefaults: Query): void {
  // The preset supplies this route's defaults. They are url parameters, so they
  // are decoded like a url, over the store's own defaults — and before the
  // defaults are captured and before the url itself is read.
  applyQuery(entry, presetDefaults, snapshot(entry), "preset default");
  entry.defaults = snapshot(entry);

  entry.arrival = normalizeQuery(router.currentRoute.value.query, new Set(entry.specs.map(paramOf)));
  applyQuery(entry, entry.arrival);
  arrivedAt = withoutClock(buildQuery(router, hydratedEntries()));

  // Normalise the url to what the state actually is — dropping anything
  // invalid and anything that turned out to equal a default. Replace rather
  // than push: arriving at a page is not a state change.
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

  // Watch the synced values rather than $subscribe: guarded keys are exposed
  // as computeds over private refs, and a private ref is not part of $state, so
  // $subscribe never sees an activation or layer change. Watching the schema's
  // own keys also means state that is deliberately not synced — catalogRevision,
  // pickMode — cannot reach the url at all.
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
 * What the link the page was opened on said for `param`, as it spelled it.
 * Hydration drops a value equal to its default from the url, so this is the
 * only place left to ask whether the link named it. Undefined if it did not,
 * and for everything once a change has been pushed.
 */
export function arrivalParam(param: string): string | undefined {
  for (const entry of registry.values()) {
    if (entry.specs.some((spec) => paramOf(spec) === param)) {
      return entry.arrival?.[param];
    }
  }
  return undefined;
}

/**
 * Derive one parameter's default from its route default, or pass `undefined`
 * to go back to the route default. The url is rewritten against the result.
 */
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
