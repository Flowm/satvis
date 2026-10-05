// The non-reactive registry of known satellites. Must stay Cesium-free: node-env
// vitest exercises it.

import type { OrbitClass } from "../config/orbitClass";
import type { ElementsEntry } from "../config/presets";
import type { SatelliteMetadata } from "../config/satelliteMetadata";
import { orbitClassOf, parseGpPayload, recordName, recordSatnum, type GpRecord } from "./util/gp";
import { fetchGpGroup, fetchGpIndex } from "./util/gpSource";

export class CatalogEntry {
  // satnum + "|" + name.
  readonly key: string;

  readonly name: string;

  readonly nameUpper: string;

  readonly satnum: string;

  // addRecords reassigns it when merging tags across groups.
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

  // Attached by the worker at refresh time. Empty for a hand-built record, where
  // consumers apply their own defaults.
  get metadata(): SatelliteMetadata {
    return this.record.metadata ?? {};
  }

  // parseGpPayload caches the class; this falls back only for hand-built records.
  get orbitClass(): OrbitClass {
    return this.metadata.orbitClass ?? orbitClassOf(this.record);
  }
}

// Registered up front so the UI can list it; fetched only on demand.
interface RegisteredGroup {
  source: string;
  tags: string[];
  searchOnly: boolean;
  loaded: boolean;
  // Cleared on failure so a later ensure call retries.
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

  #registry = new Map<string, RegisteredGroup>();

  #indexCounts = new Map<string, number>();

  #indexLoad: Promise<void> | undefined;

  // Repeated registration merges tags. A group is search-only until some preset
  // registers it as a full group.
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

  // Best-effort: an unavailable index leaves the estimated counts at 0.
  ensureIndex(): Promise<void> {
    this.#indexLoad ??= fetchGpIndex().then((index) => {
      for (const group of index.groups) {
        if (typeof group.count === "number") {
          this.#indexCounts.set(group.name, group.count);
        }
      }
    });
    return this.#indexLoad;
  }

  // Per-group errors are logged and skipped.
  ensureTags(tags: readonly string[]): Promise<void> {
    const wanted = new Set(tags);
    const loads = [...this.#registry.values()].filter((group) => group.tags.some((tag) => wanted.has(tag))).map((group) => this.#ensureGroup(group));
    return Promise.all(loads).then(() => undefined);
  }

  ensureAll(): Promise<void> {
    const loads = [...this.#registry.values()].map((group) => this.#ensureGroup(group));
    return Promise.all(loads).then(() => undefined);
  }

  // True for tags without a registered source, e.g. custom records.
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

  // Returns the entries that were added or whose tags changed.
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

  // Unloaded groups add an estimate from the group index, which may double-count
  // satellites shared with a loaded group. A tag is search-only when every
  // registered source carrying it is.
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

function mergeTags(existing: string[], added: string[]): string[] {
  const result = [...existing];
  for (const tag of added) {
    if (!result.includes(tag)) {
      result.push(tag);
    }
  }
  return result;
}
