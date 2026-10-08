// The satellite table (CONTEXT.md): the static facts about each satellite, from the
// upstream tables and the curated rows, attached to the GP records at refresh time
// (ADR 0002, 0007, 0008).

import { enrichmentSatnum } from "./evaluate.ts";
import { GCAT_CATALOG, GCAT_ORGS, GCAT_PAYLOADS, gcatBags } from "./gcat.ts";
import { SATCAT } from "./satcat.ts";
import type { GroupStore } from "./store.ts";
import type { GpRecord, GroupsConfig, SatelliteEntry } from "./types.ts";
import { loadUpstream } from "./upstream.ts";

type Bags = Record<string, Record<string, unknown>>;

/** What an upstream table gives the satellite table: one bag per normalized satnum. */
interface Contribution {
  name: string;
  bags: Bags;
}

/** The upstream contributors, each read from its stored files; a missing file gives no bags. */
const CONTRIBUTORS: readonly { name: string; load: (store: GroupStore) => Promise<Bags> }[] = [
  { name: "satcat", load: async (store) => (await loadUpstream(SATCAT, store)) ?? {} },
  {
    name: "gcat",
    // One after another, so each file's text is released before the next.
    load: async (store) => gcatBags(await loadUpstream(GCAT_CATALOG, store), await loadUpstream(GCAT_ORGS, store), await loadUpstream(GCAT_PAYLOADS, store)),
  },
];

export class SatelliteTable {
  /** Metadata by normalized satnum. */
  readonly #facts: Map<string, Record<string, unknown>>;

  readonly #entries: readonly SatelliteEntry[];

  readonly #matched = new Set<string>();

  /** Rows each contributor gave, by its name. */
  readonly rows: Readonly<Record<string, number>>;

  /**
   * Upstream bags first, in no particular order: each field has one owner (ADR 0008).
   * Curated rows extend them field by field, and a bus model fills in only where no
   * model is named (ADR 0007).
   */
  constructor(contributions: readonly Contribution[], entries: readonly SatelliteEntry[] = [], modelBuses: Readonly<Record<string, string>> = {}) {
    this.#entries = entries;
    const facts = new Map<string, Record<string, unknown>>();
    const rows: Record<string, number> = {};
    for (const { name, bags } of contributions) {
      rows[name] = Object.keys(bags).length;
      for (const [satnum, bag] of Object.entries(bags)) {
        const previous = facts.get(satnum);
        facts.set(satnum, previous === undefined ? bag : { ...previous, ...bag });
      }
    }
    for (const entry of entries) {
      const satnum = String(entry.noradId);
      const upstream = facts.get(satnum);
      facts.set(satnum, upstream === undefined ? entry.metadata : { ...upstream, ...entry.metadata });
    }
    for (const [satnum, metadata] of facts) {
      const modelFile = typeof metadata.bus === "string" ? modelBuses[metadata.bus] : undefined;
      if (modelFile !== undefined && metadata.modelFile === undefined) {
        facts.set(satnum, { ...metadata, modelFile });
      }
    }
    this.#facts = facts;
    this.rows = rows;
  }

  /** From the stored upstream tables and `config`'s curated rows and bus models. */
  static async load(store: GroupStore, config: GroupsConfig): Promise<SatelliteTable> {
    const contributions: Contribution[] = [];
    for (const { name, load } of CONTRIBUTORS) {
      // eslint-disable-next-line no-await-in-loop -- one table in memory at a time; GCAT's file is 19 MB
      contributions.push({ name, bags: await load(store) });
    }
    return new SatelliteTable(contributions, config.satellites, config.modelBuses);
  }

  /**
   * Each record the table knows gets its facts as `metadata`, which cannot collide with a
   * CelesTrak field: those are all upper case. The others are returned as they are, and
   * the frontend applies its defaults.
   */
  enrich(records: GpRecord[]): GpRecord[] {
    if (this.#facts.size === 0) {
      return records;
    }
    return records.map((record) => {
      const satnum = enrichmentSatnum(record);
      const metadata = this.#facts.get(satnum);
      if (metadata === undefined) {
        return record;
      }
      this.#matched.add(satnum);
      return { ...record, metadata };
    });
  }

  /** Curated rows no enriched record matched, apart from decayed satellites. Meaningful once every group is enriched. */
  unmatched(): SatelliteEntry[] {
    return this.#entries.filter((entry) => !entry.decayed && !this.#matched.has(String(entry.noradId)));
  }
}
