// One contract for every GroupStore adapter: KV and memory in store.test.ts, disk in
// scripts/check-disk-store.mjs under node:test. Each case gets an empty store, and
// `equal` is its runner's deep-equality assertion.

import { type GroupStore, upstreamStatuses } from "../src/gp/store.ts";
import type { GroupsIndex, OmmRecord } from "../src/gp/types.ts";

export type Equal = (actual: unknown, expected: unknown, message?: string) => void;

const INDEX: GroupsIndex = { updated: "2026-10-07T00:00:00.000Z", groups: [{ name: "stations", updated: "2026-10-07T00:00:00.000Z", count: 1 }] };
const ISS: OmmRecord[] = [{ OBJECT_NAME: "ISS (ZARYA)", NORAD_CAT_ID: 25544 }];

export const STORE_CONTRACT: Record<string, (store: GroupStore, equal: Equal) => Promise<void>> = {
  "reads an empty index before one is written, then the one written": async (store, equal) => {
    equal(await store.readIndex(), { updated: "", groups: [] });
    await store.writeIndex(INDEX);
    equal(await store.readIndex(), INDEX);
  },

  "reads a group back as written, and nothing for one never written": async (store, equal) => {
    await store.writeGroup("stations", ISS, { updated: INDEX.updated, count: 1 });
    equal(JSON.parse((await store.readGroup("stations"))?.body ?? "null"), ISS);
    equal(await store.readGroup("weather"), undefined);
  },

  "keeps an upstream file's bytes, and lists the tables that have one": async (store, equal) => {
    equal([...(await store.listUpstreams())], []);
    await store.writeUpstream("satcat", new Uint8Array([31, 139, 8]));
    equal([...((await store.readUpstream("satcat")) ?? [])], [31, 139, 8]);
    equal(await store.readUpstream("gcat"), undefined);
    equal([...(await store.listUpstreams())], ["satcat"]);
  },

  "keeps one status per table, and lists them all": async (store, equal) => {
    await store.writeStatus("satcat", { checked: INDEX.updated, rows: 2 });
    await store.writeStatus("gcat", { lastError: "HTTP 500", lastErrorAt: INDEX.updated });
    await store.writeStatus("satcat", { checked: INDEX.updated, rows: 3 });
    equal(await store.readStatus("satcat"), { checked: INDEX.updated, rows: 3 });
    equal(await store.readStatus("gcatOrgs"), undefined);
    equal(await store.listStatuses(), { satcat: { checked: INDEX.updated, rows: 3 }, gcat: { lastError: "HTTP 500", lastErrorAt: INDEX.updated } });
  },

  "reads a table's ETag only while its file is stored": async (store, equal) => {
    await store.writeStatus("satcat", { checked: INDEX.updated, etag: '"a"' });
    await store.writeStatus("gcat", { checked: INDEX.updated, etag: '"b"' });
    await store.writeUpstream("gcat", new Uint8Array([1]));
    equal(await upstreamStatuses(store), { satcat: { checked: INDEX.updated, stored: false }, gcat: { checked: INDEX.updated, etag: '"b"', stored: true } });
  },
};
