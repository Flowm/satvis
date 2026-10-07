// The disk adapter of the GroupStore (src/gp/store.ts), for the static data/gp/ snapshot
// that scripts/update-static-gp.mjs writes. Held to the contract in test/storeContract.ts
// by scripts/check-disk-store.mjs.

import fs from "node:fs";
import path from "node:path";

import { coerceIndex } from "../src/gp/evaluate.ts";

/** Undefined for a missing or corrupt file: as if never written. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const STATUS_SUFFIX = ".status.json";

/**
 * Groups and the index in `dir`, served as they are. The upstream tables in `upstreamDir`,
 * kept outside data/ because everything under data/ ships: `<name>.gz`, the file as
 * downloaded, compressed, and `<name>.status.json`. A group's write metadata is not kept:
 * the snapshot's index carries both its `updated` and its `count`.
 */
export function diskGroupStore(dir, upstreamDir) {
  const indexPath = path.join(dir, "index.json");
  const groupPath = (name) => path.join(dir, `${name}.json`);
  const statusPath = (name) => path.join(upstreamDir, `${name}${STATUS_SUFFIX}`);
  const filesEndingIn = (suffix) => (fs.existsSync(upstreamDir) ? fs.readdirSync(upstreamDir).filter((file) => file.endsWith(suffix)) : []);
  return {
    async readIndex() {
      return coerceIndex(readJson(indexPath));
    },
    async readGroup(name) {
      const file = groupPath(name);
      return fs.existsSync(file) ? { body: fs.readFileSync(file, "utf8").trimEnd() } : undefined;
    },
    async writeGroup(name, records) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(groupPath(name), `${JSON.stringify(records)}\n`);
    },
    async writeIndex(index) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    },
    async readUpstream(name) {
      const file = path.join(upstreamDir, `${name}.gz`);
      return fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : undefined;
    },
    async writeUpstream(name, bytes) {
      fs.mkdirSync(upstreamDir, { recursive: true });
      fs.writeFileSync(path.join(upstreamDir, `${name}.gz`), bytes);
    },
    async listUpstreams() {
      return new Set(filesEndingIn(".gz").map((file) => file.slice(0, -3)));
    },
    async readStatus(name) {
      return readJson(statusPath(name));
    },
    async writeStatus(name, status) {
      fs.mkdirSync(upstreamDir, { recursive: true });
      fs.writeFileSync(statusPath(name), `${JSON.stringify(status)}\n`);
    },
    async listStatuses() {
      return Object.fromEntries(
        filesEndingIn(STATUS_SUFFIX).flatMap((file) => {
          const status = readJson(path.join(upstreamDir, file));
          return status === undefined ? [] : [[file.slice(0, -STATUS_SUFFIX.length), status]];
        }),
      );
    },
  };
}
