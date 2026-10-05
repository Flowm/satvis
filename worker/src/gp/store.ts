// The KV adapter is below; scripts/update-static-gp.mjs has the disk one.

import { coerceIndex } from "./evaluate.ts";
import type { GpRecord, GroupsIndex, SatcatSnapshot } from "./types.ts";

export const GP_KEY_PREFIX = "gp:";
export const GP_INDEX_KEY = "gp:index";
export const SATCAT_KEY = "gp:satcat";

/** The API builds ETag and Last-Modified from it. */
export interface GroupWriteMetadata {
  updated: string;
  count: number;
}

export interface GroupStore {
  /** The last written index; empty (coerced) when missing or corrupt. */
  readIndex(): Promise<GroupsIndex>;
  writeGroup(name: string, records: GpRecord[], metadata: GroupWriteMetadata): Promise<void>;
  writeIndex(index: GroupsIndex): Promise<void>;
  /** Undefined when none is stored or it is unreadable. A 304 makes it the input to enrichment. */
  readSatcat(): Promise<SatcatSnapshot | undefined>;
  writeSatcat(snapshot: SatcatSnapshot): Promise<void>;
}

/** A corrupt key means no SATCAT this run, not a throw mid-refresh. */
function coerceSatcat(raw: unknown): SatcatSnapshot | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const { rows, updated } = raw as SatcatSnapshot;
  if (rows === null || typeof rows !== "object" || Array.isArray(rows) || typeof updated !== "string") {
    return undefined;
  }
  return raw as SatcatSnapshot;
}

export function kvGroupStore(kv: KVNamespace): GroupStore {
  return {
    async readIndex(): Promise<GroupsIndex> {
      return coerceIndex(await kv.get(GP_INDEX_KEY, "json"));
    },
    async writeGroup(name: string, records: GpRecord[], metadata: GroupWriteMetadata): Promise<void> {
      await kv.put(GP_KEY_PREFIX + name, JSON.stringify(records), { metadata });
    },
    async writeIndex(index: GroupsIndex): Promise<void> {
      await kv.put(GP_INDEX_KEY, JSON.stringify(index));
    },
    async readSatcat(): Promise<SatcatSnapshot | undefined> {
      return coerceSatcat(await kv.get(SATCAT_KEY, "json"));
    },
    async writeSatcat(snapshot: SatcatSnapshot): Promise<void> {
      await kv.put(SATCAT_KEY, JSON.stringify(snapshot));
    },
  };
}
