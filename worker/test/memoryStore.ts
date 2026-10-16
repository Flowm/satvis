// A GroupStore in memory, held to the KV and disk adapters' contract (storeContract.ts);
// refresh.test.ts and upstream.test.ts share it.

import type { GroupStore, GroupWriteMetadata } from "../src/gp/store.ts";
import type { GpRecord, GroupsIndex, UpstreamName, UpstreamStatus } from "../src/gp/types.ts";

/** `previous` is the index a refresh reads until one is written; the accessors read back what it wrote. */
export function memoryStore(previous: GroupsIndex = { updated: "", groups: [] }) {
  const groups = new Map<string, { records: GpRecord[]; metadata: GroupWriteMetadata }>();
  const files = new Map<UpstreamName, Uint8Array>();
  const rows = new Map<UpstreamName, unknown>();
  const statuses = new Map<UpstreamName, UpstreamStatus>();
  let index: GroupsIndex | undefined;
  const store: GroupStore = {
    async readIndex() {
      return index ?? previous;
    },
    async readGroup(name) {
      const group = groups.get(name);
      return group && { body: JSON.stringify(group.records), metadata: group.metadata };
    },
    async writeGroup(name, records, metadata) {
      groups.set(name, { records, metadata });
    },
    async writeIndex(newIndex) {
      index = newIndex;
    },
    async readUpstream(name) {
      return files.get(name);
    },
    async writeUpstream(name, bytes) {
      files.set(name, bytes);
    },
    async listUpstreams() {
      return new Set(files.keys());
    },
    async readUpstreamRows(name) {
      // A copy each way, as KV and disk round-trip through JSON.
      const stored = rows.get(name);
      return stored === undefined ? undefined : structuredClone(stored);
    },
    async writeUpstreamRows(name, value) {
      rows.set(name, structuredClone(value));
    },
    async readStatus(name) {
      return statuses.get(name);
    },
    async writeStatus(name, status) {
      statuses.set(name, status);
    },
    async listStatuses() {
      return Object.fromEntries(statuses);
    },
  };
  return { store, groups, files, rows, statuses, index: () => index };
}
