// The disk adapter against the GroupStore contract (test/storeContract.ts). node:test,
// not vitest-pool-workers: it writes files, which workerd cannot.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { STORE_CONTRACT } from "../test/storeContract.ts";
import { diskGroupStore } from "./diskStore.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "satvis-disk-store-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

for (const [title, check] of Object.entries(STORE_CONTRACT)) {
  test(`the disk group store ${title}`, async () => {
    const dir = mkdtempSync(path.join(scratch, "case-"));
    await check(diskGroupStore(path.join(dir, "gp"), path.join(dir, "upstream")), (actual, expected, message) => assert.deepStrictEqual(actual, expected, message));
  });
}
