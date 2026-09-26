// SatelliteCatalog — the frontend's plain, non-reactive registry of known
// satellites, decoupled from instantiated Cesium objects. It owns O(n) dedup
// and tag merging.
//
// This module must stay Cesium-free (node-env vitest exercises it).

import type { OrbitClass } from "../config/orbitClass";
import type { ElementsEntry } from "../config/presets";
import type { SatelliteMetadata } from "../config/satelliteMetadata";
import { orbitClassOf, parseGpPayload, recordName, recordSatnum, type GpRecord } from "./util/gp";
import { fetchGpGroup, fetchGpIndex } from "./util/gpSource";

// A single known satellite. Created by SatelliteCatalog.addRecords, which owns
// the identity/tag indices.
export class CatalogEntry {
  // Dedup identity: satnum + "|" + name.
  readonly key: string;

  readonly name: string;

  readonly nameUpper: string;

  readonly satnum: string;

  // Mutable: addRecords reassigns it when merging tags across groups.
  tags: string[];

  readonly record: GpRecord;

  constructor(fields: { key: string; name: string; nameUpper: string; satnum: string; tags: string[]; record: GpRecord }) {
    this.key = fields.key;
    this.name = fields.name;
    this.nameUpper = fields.nameUpper;
    this.satnum = fields.satnum;
    this.tags = fields.tags;
    this.record = fields.record;
  }

  // Static per-satellite facts (swath extents, cone FOV, model URL, operator),
  // attached to the record by the worker at refresh time, plus the derived
  // orbit class cached by parseGpPayload. Empty for a hand-built record —
  // consumers apply their own defaults. No resolution or memoization: the
  // record either carries the bag or it does not.
  get metadata(): SatelliteMetadata {
    return this.record.metadata ?? {};
  }

  // The single place the cache miss is handled: every record out of
  // parseGpPayload carries the class, so this falls back only for records built
  // by hand. Deriving it again is two number reads, not a satrec.
  get orbitClass(): OrbitClass {
    return this.metadata.orbitClass ?? orbitClassOf(this.record);
  }
}

// A preset group source known to the catalog but fetched lazily: registered
// up front (so the UI can list it), loaded only once one of its tags becomes
// active, it is expanded/searched in the browser, or an unresolved satellite
// name forces a full load.
interface RegisteredGroup {
  source: string;
  tags: string[];
  searchOnly: boolean;
  loaded: boolean;
  // Memoized in-flight/completed load; cleared on failure so a later ensure
  // call retries.
  load: Promise<void> | undefined;
}

export type CatalogChangeCallback = (entries: CatalogEntry[]) => void;

export class SatelliteCatalog {
  #byKey = new Map<string, CatalogEntry>();

  #byName = new Map<string, CatalogEntry>();

  #bySatnum = new Map<string, CatalogEntry[]>();

  #byTag = new Map<string, Set<CatalogEntry>>();

  #changeCallbacks: CatalogChangeCallback[] = [];

  onChange(cb: CatalogChangeCallback): void {
    this.#changeCallbacks.push(cb);
  }

  #notifyChange(entries: CatalogEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    this.#changeCallbacks.forEach((cb) => cb(entries));
  }

  // Lazily-loaded preset groups by source name, plus per-source record counts
  // from the group index (display estimates for not-yet-loaded groups).
  #registry = new Map<string, RegisteredGroup>();

  #indexCounts = new Map<string, number>();

  #indexLoad: Promise<void> | undefined;

  // Register preset groups without fetching them. Repeated registration (e.g.
  // navigating between presets) merges tags; already-loaded groups stay loaded.
  // A group is search-only until some preset registers it as a full group.
  registerGroups(sourceTagList: ReadonlyArray<ElementsEntry>): void {
    for (const [source, tags, options] of sourceTagList) {
      const searchOnly = options?.searchOnly === true;
      const existing = this.#registry.get(source);
      if (existing) {
        existing.tags = mergeTags(existing.tags, tags);
        existing.searchOnly = existing.searchOnly && searchOnly;
        continue;
      }
      this.#registry.set(source, { source, tags: [...tags], searchOnly, loaded: false, load: undefined });
    }
  }

  // Fetch the group index (names + record counts) so unloaded groups can show
  // an estimated count in the UI. Best-effort: an unavailable index just leaves
  // the estimates at 0.
  ensureIndex(): Promise<void> {
    this.#indexLoad ??= fetchGpIndex().then((index) => {
      for (const group of index) {
        if (typeof group.count === "number") {
          this.#indexCounts.set(group.name, group.count);
        }
      }
    });
    return this.#indexLoad;
  }

  // Load every registered group carrying one of the given tags. Loads are
  // memoized per group; per-group errors are logged and skipped.
  ensureTags(tags: readonly string[]): Promise<void> {
    const wanted = new Set(tags);
    const loads = [...this.#registry.values()].filter((group) => group.tags.some((tag) => wanted.has(tag))).map((group) => this.#ensureGroup(group));
    return Promise.all(loads).then(() => undefined);
  }

  // Load every registered group (needed for cross-group search and for
  // satellite names whose group is unknown, e.g. URL-enabled sats).
  ensureAll(): Promise<void> {
    const loads = [...this.#registry.values()].map((group) => this.#ensureGroup(group));
    return Promise.all(loads).then(() => undefined);
  }

  // True once every registered group carrying the tag has loaded (trivially
  // true for tags without a registered source, e.g. custom records).
  isTagLoaded(tag: string): boolean {
    for (const group of this.#registry.values()) {
      if (!group.loaded && group.tags.includes(tag)) {
        return false;
      }
    }
    return true;
  }

  #ensureGroup(group: RegisteredGroup): Promise<void> {
    group.load ??= this.#loadRegisteredGroup(group);
    return group.load;
  }

  async #loadRegisteredGroup(group: RegisteredGroup): Promise<void> {
    try {
      const text = await fetchGpGroup(group.source);
      const records = parseGpPayload(text);
      const changed = this.addRecords(records, group.tags);
      group.loaded = true;
      this.#notifyChange(changed);
    } catch (error) {
      console.log(error);
      group.load = undefined;
    }
  }

  // Add records with the given tags, deduping by key and merging tags. Returns
  // the entries that were added or whose tags changed (for the change callback).
  addRecords(records: GpRecord[], tags: string[]): CatalogEntry[] {
    const changed: CatalogEntry[] = [];
    for (const record of records) {
      const name = recordName(record);
      const satnum = recordSatnum(record);
      const key = `${satnum}|${name}`;
      const existing = this.#byKey.get(key);
      if (existing) {
        const before = existing.tags.length;
        existing.tags = mergeTags(existing.tags, tags);
        if (existing.tags.length !== before) {
          this.#indexTags(existing);
          changed.push(existing);
        }
        continue;
      }
      const entry = new CatalogEntry({
        key,
        name,
        nameUpper: name.toUpperCase(),
        satnum,
        tags: [...tags],
        record,
      });
      this.#byKey.set(key, entry);
      // First-wins by name.
      if (!this.#byName.has(name)) {
        this.#byName.set(name, entry);
      }
      const satnumEntries = this.#bySatnum.get(satnum) ?? [];
      satnumEntries.push(entry);
      this.#bySatnum.set(satnum, satnumEntries);
      this.#indexTags(entry);
      changed.push(entry);
    }
    return changed;
  }

  #indexTags(entry: CatalogEntry): void {
    for (const tag of entry.tags) {
      const tagEntries = this.#byTag.get(tag) ?? new Set();
      tagEntries.add(entry);
      this.#byTag.set(tag, tagEntries);
    }
  }

  // All known groups: tags with loaded entries (exact counts) plus registered
  // but not-yet-loaded sources (estimated counts from the group index, 0 until
  // the index arrives). Estimates may double-count satellites shared with a
  // loaded group; they are replaced by exact counts once the group loads.
  // A tag is search-only when every registered source carrying it is.
  get groups(): { tag: string; count: number; searchOnly: boolean }[] {
    const counts = new Map<string, number>();
    const searchOnly = new Map<string, boolean>();
    for (const [tag, entries] of this.#byTag) {
      counts.set(tag, entries.size);
    }
    for (const group of this.#registry.values()) {
      const estimate = group.loaded ? 0 : (this.#indexCounts.get(group.source) ?? 0);
      for (const tag of group.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + estimate);
        searchOnly.set(tag, (searchOnly.get(tag) ?? true) && group.searchOnly);
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count, searchOnly: searchOnly.get(tag) ?? false }));
  }

  entriesWithTag(tag: string): CatalogEntry[] {
    return [...(this.#byTag.get(tag) ?? [])];
  }

  getByName(name: string): CatalogEntry | undefined {
    return this.#byName.get(name);
  }

  get size(): number {
    return this.#byKey.size;
  }

  get entries(): CatalogEntry[] {
    return [...this.#byKey.values()];
  }
}

// Union merge preserving order.
function mergeTags(existing: string[], added: string[]): string[] {
  const result = [...existing];
  for (const tag of added) {
    if (!result.includes(tag)) {
      result.push(tag);
    }
  }
  return result;
}
