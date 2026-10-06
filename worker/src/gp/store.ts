// The KV adapter is below; scripts/update-static-gp.mjs has the disk one.

import { coerceIndex } from "./evaluate.ts";
import type { GpRecord, GroupsIndex, UpstreamName, UpstreamStatus } from "./types.ts";

export const GP_KEY_PREFIX = "gp:";
export const GP_INDEX_KEY = "gp:index";
/** The stored upstream files, gzip-compressed by upstream.ts. */
export const UPSTREAM_KEY_PREFIX = "upstream:";
/** One per upstream file, value empty, the status in its metadata, so one list() reads them all. */
export const STATUS_KEY_PREFIX = "status:";

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
  /** The stored file's bytes as written; undefined when none is stored. */
  readUpstream(name: UpstreamName): Promise<Uint8Array | undefined>;
  writeUpstream(name: UpstreamName, bytes: Uint8Array): Promise<void>;
  /**
   * The tables with a stored file, without reading one. A status can outlive its file,
   * and its ETag must not then make a download conditional (upstream.ts).
   */
  listUpstreams(): Promise<Set<UpstreamName>>;
  readStatus(name: UpstreamName): Promise<UpstreamStatus | undefined>;
  writeStatus(name: UpstreamName, status: UpstreamStatus): Promise<void>;
  /** Every stored status, by name. */
  listStatuses(): Promise<Partial<Record<UpstreamName, UpstreamStatus>>>;
}

/** KV caps metadata at 1024 bytes of JSON; this leaves room for the KV wrapper. */
const MAX_STATUS_BYTES = 1000;
/** A longer ETag is dropped, not cut: a cut one would never match, and none is ever this long. */
const MAX_ETAG_BYTES = 200;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Fits a status into KV metadata. `etag` arrives in a client header and `lastError`
 * from any failure, so both are bounded, in bytes; the rest is fixed-size.
 */
export function boundStatus(status: UpstreamStatus): UpstreamStatus {
  const { etag, lastError, ...rest } = status;
  const bounded: UpstreamStatus = { ...rest, ...(etag !== undefined && byteLength(etag) <= MAX_ETAG_BYTES && { etag }) };
  if (lastError === undefined) {
    return bounded;
  }
  const room = MAX_STATUS_BYTES - byteLength(JSON.stringify({ ...bounded, lastError: "" }));
  const bytes = encoder.encode(lastError);
  // A cut through a multi-byte character decodes as U+FFFD, three bytes for the one or
  // two it replaces, so it goes; the "…" takes three.
  return { ...bounded, lastError: bytes.length <= room ? lastError : `${decoder.decode(bytes.slice(0, Math.max(0, room - 3))).replace(/\uFFFD$/, "")}…` };
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
    async readUpstream(name: UpstreamName): Promise<Uint8Array | undefined> {
      const value = await kv.get(UPSTREAM_KEY_PREFIX + name, "arrayBuffer");
      return value === null ? undefined : new Uint8Array(value);
    },
    async writeUpstream(name: UpstreamName, bytes: Uint8Array): Promise<void> {
      await kv.put(UPSTREAM_KEY_PREFIX + name, bytes);
    },
    async listUpstreams(): Promise<Set<UpstreamName>> {
      const { keys } = await kv.list({ prefix: UPSTREAM_KEY_PREFIX });
      return new Set(keys.map(({ name }) => name.slice(UPSTREAM_KEY_PREFIX.length) as UpstreamName));
    },
    async readStatus(name: UpstreamName): Promise<UpstreamStatus | undefined> {
      const { metadata } = await kv.getWithMetadata<UpstreamStatus>(STATUS_KEY_PREFIX + name);
      return metadata ?? undefined;
    },
    async writeStatus(name: UpstreamName, status: UpstreamStatus): Promise<void> {
      await kv.put(STATUS_KEY_PREFIX + name, "", { metadata: boundStatus(status) });
    },
    async listStatuses(): Promise<Partial<Record<UpstreamName, UpstreamStatus>>> {
      const { keys } = await kv.list<UpstreamStatus>({ prefix: STATUS_KEY_PREFIX });
      return Object.fromEntries(keys.flatMap(({ name, metadata }) => (metadata === undefined ? [] : [[name.slice(STATUS_KEY_PREFIX.length), metadata]])));
    },
  };
}
