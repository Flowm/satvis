import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { kvGroupStore } from "../src/gp/store.ts";
import { memoryStore } from "./memoryStore.ts";
import { STORE_CONTRACT } from "./storeContract.ts";

const equal = (actual: unknown, expected: unknown, message?: string) => expect(actual, message).toEqual(expected);

describe.each([
  ["KV", () => kvGroupStore(env.GP_KV)],
  ["memory", () => memoryStore().store],
])("the %s group store", (_name, open) => {
  beforeEach(async () => {
    const { keys } = await env.GP_KV.list();
    await Promise.all(keys.map(({ name }) => env.GP_KV.delete(name)));
  });

  for (const [title, check] of Object.entries(STORE_CONTRACT)) {
    it(title, () => check(open(), equal));
  }

  it("keeps a group's write metadata", async () => {
    const store = open();
    await store.writeGroup("stations", [], { updated: "2026-10-07T00:00:00.000Z", count: 0 });
    expect((await store.readGroup("stations"))?.metadata).toEqual({ updated: "2026-10-07T00:00:00.000Z", count: 0 });
  });
});
