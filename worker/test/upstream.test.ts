import { describe, expect, it } from "vitest";

import type { FetchImpl } from "../src/gp/evaluate.ts";
import { parseGcatCatalog } from "../src/gp/gcat.ts";
import { SATCAT, SATCAT_URL } from "../src/gp/satcat.ts";
import { boundStatus } from "../src/gp/store.ts";
import { loadUpstream, recordFailure, recordUnchanged, refreshUpstream, storedEtag, storeUpstream } from "../src/gp/upstream.ts";
import { memoryStore } from "./memoryStore.ts";

const SATCAT_CSV = [
  "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER,LAUNCH_DATE,LAUNCH_SITE,DECAY_DATE,PERIOD,INCLINATION,APOGEE,PERIGEE,RCS,DATA_STATUS_CODE,ORBIT_CENTER,ORBIT_TYPE",
  "ISS (ZARYA),1998-067A,25544,PAY,+,ISS,1998-11-20,TYMSC,,92.94,51.63,424,414,399.0524,,EA,ORB",
].join("\r\n");

const NOW = "2026-10-07T00:00:00.000Z";
const LATER = "2026-10-08T00:00:00.000Z";

describe("storeUpstream", () => {
  it("stores the file compressed, and reads back exactly what was stored", async () => {
    const { store, files } = memoryStore();
    const { stored, status } = await storeUpstream(SATCAT, store, SATCAT_CSV, '"abc"', NOW);

    expect(stored).toBe(true);
    expect(status).toEqual({ updated: NOW, checked: NOW, etag: '"abc"', bytes: SATCAT_CSV.length, rows: 1 });
    // gzip's magic bytes: the file is stored compressed, not as text.
    expect(Array.from(files.get("satcat")!.slice(0, 2))).toEqual([0x1f, 0x8b]);
    expect(await loadUpstream(SATCAT, store)).toEqual({ "25544": expect.objectContaining({ launchSite: "TYMSC" }) });
  });

  it("refuses a file that does not parse, and keeps the stored one", async () => {
    const { store } = memoryStore();
    await storeUpstream(SATCAT, store, SATCAT_CSV, '"abc"', NOW);
    const { stored, status } = await storeUpstream(SATCAT, store, "<html>503</html>", '"def"', LATER);

    expect(stored).toBe(false);
    // The old file, ETag and times stand, so the next download stays conditional on them,
    // and a table refused day after day goes stale.
    expect(status).toMatchObject({ updated: NOW, etag: '"abc"', checked: NOW, lastErrorAt: LATER });
    expect(status.lastError).toMatch(/^refused: .*NORAD_CAT_ID/);
    expect(await loadUpstream(SATCAT, store)).toHaveProperty("25544");
  });

  it("refuses a file that parses to under half the stored rows, as one cut at a line break", async () => {
    const { store } = memoryStore();
    const [header, iss] = SATCAT_CSV.split("\r\n") as [string, string];
    const rows = (count: number) => [header, ...Array.from({ length: count }, (_, i) => iss.replace("25544", String(90000 + i)))].join("\r\n");
    await storeUpstream(SATCAT, store, rows(10), '"abc"', NOW);

    const { stored, status } = await storeUpstream(SATCAT, store, rows(4), '"def"', LATER);
    expect(stored).toBe(false);
    expect(status).toMatchObject({ rows: 10, etag: '"abc"' });
    expect(status.lastError).toBe("refused: 4 rows, against 10 stored: cut off?");
    expect((await storeUpstream(SATCAT, store, rows(5), '"ghi"', LATER)).stored).toBe(true);
  });

  it("clears an earlier error once a file is stored", async () => {
    const { store } = memoryStore();
    await recordFailure("satcat", store, "HTTP 522", NOW);
    const { status } = await storeUpstream(SATCAT, store, SATCAT_CSV, undefined, LATER);
    expect(status).not.toHaveProperty("lastError");
  });
});

describe("recordUnchanged and recordFailure", () => {
  it("record a 304 as a check, and a failure as an error that leaves the check", async () => {
    const { store } = memoryStore();
    await storeUpstream(SATCAT, store, SATCAT_CSV, '"abc"', NOW);

    expect(await recordUnchanged("satcat", store, LATER)).toMatchObject({ updated: NOW, checked: LATER, etag: '"abc"', rows: 1 });
    expect(await recordFailure("satcat", store, "HTTP 522", "2026-10-09T00:00:00.000Z")).toMatchObject({ checked: LATER, lastError: "HTTP 522" });
  });

  it("clear an error once upstream answers 304, which means it still serves the stored file", async () => {
    const { store } = memoryStore();
    await storeUpstream(SATCAT, store, SATCAT_CSV, '"abc"', NOW);
    await recordFailure("satcat", store, "HTTP 522", NOW);
    const status = await recordUnchanged("satcat", store, LATER);
    expect(status).not.toHaveProperty("lastError");
    expect(status).not.toHaveProperty("lastErrorAt");
  });
});

describe("storedEtag", () => {
  it("offers no ETag for a status whose file is gone, so the next download is whole", async () => {
    const { store, files } = memoryStore();
    await storeUpstream(SATCAT, store, SATCAT_CSV, '"abc"', NOW);
    expect(await storedEtag("satcat", store)).toBe('"abc"');

    files.delete("satcat");
    expect(await storedEtag("satcat", store)).toBeUndefined();
  });
});

describe("boundStatus", () => {
  it("cuts the error to fit KV's metadata in bytes, and drops an ETag too long to be real", () => {
    // Three bytes a character: a cut by characters would still overflow 1024 bytes.
    const bounded = boundStatus({ updated: NOW, checked: NOW, etag: `"${"x".repeat(300)}"`, rows: 1, lastError: "€".repeat(2000), lastErrorAt: NOW });
    expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(1000);
    expect(bounded).not.toHaveProperty("etag");
    expect(bounded.lastError).toMatch(/^€+.*…$/);
  });

  it("counts the error as KV does, escaped", () => {
    for (const char of ['"', "\\", "\n", "\u0001"]) {
      const bounded = boundStatus({ updated: NOW, checked: NOW, etag: `"${"x".repeat(150)}"`, rows: 1, lastError: char.repeat(1000), lastErrorAt: NOW });
      expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThanOrEqual(1000);
      expect(bounded.lastError).toMatch(/…$/);
    }
  });

  it("leaves a status that fits as it is", () => {
    const status = { updated: NOW, etag: '"abc"', lastError: "HTTP 522" };
    expect(boundStatus(status)).toEqual(status);
  });
});

/** Answers SATCAT's URL with `answer`, collecting the If-None-Match each request sent. */
function answering(answer: Awaited<ReturnType<FetchImpl>>, seen: (string | undefined)[] = []): FetchImpl {
  return async (url, init) => {
    expect(url).toBe(SATCAT_URL);
    seen.push(init?.headers?.["If-None-Match"]);
    return answer;
  };
}

describe("refreshUpstream", () => {
  it("stores a downloaded file with its ETag", async () => {
    const { store } = memoryStore();
    const status = await refreshUpstream(SATCAT, store, answering({ status: 200, headers: { get: () => '"abc"' }, text: async () => SATCAT_CSV }), NOW);
    expect(status).toMatchObject({ updated: NOW, etag: '"abc"', rows: 1 });
  });

  it("asks conditionally on the stored ETag, and records a 304 as a check", async () => {
    const { store } = memoryStore();
    await storeUpstream(SATCAT, store, SATCAT_CSV, '"abc"', NOW);
    const seen: (string | undefined)[] = [];
    const status = await refreshUpstream(SATCAT, store, answering({ status: 304, text: async () => "" }, seen), LATER);

    expect(seen).toEqual(['"abc"']);
    expect(status).toMatchObject({ updated: NOW, checked: LATER });
  });

  it("records a failed download and keeps the file", async () => {
    const { store } = memoryStore();
    await storeUpstream(SATCAT, store, SATCAT_CSV, '"abc"', NOW);
    const status = await refreshUpstream(SATCAT, store, answering({ status: 522, text: async () => "" }), LATER);

    expect(status).toMatchObject({ updated: NOW, lastError: "HTTP 522" });
    expect(await loadUpstream(SATCAT, store)).toHaveProperty("25544");
  });

  it("downloads in full when the status outlived its file", async () => {
    const { store, files } = memoryStore();
    await storeUpstream(SATCAT, store, SATCAT_CSV, '"abc"', NOW);
    files.delete("satcat");
    const seen: (string | undefined)[] = [];
    await refreshUpstream(SATCAT, store, answering({ status: 200, text: async () => SATCAT_CSV }, seen), LATER);

    expect(seen).toEqual([undefined]);
    expect(await loadUpstream(SATCAT, store)).toHaveProperty("25544");
  });
});

describe("loadUpstream", () => {
  it("answers undefined, not a throw, when nothing is stored or it no longer parses", async () => {
    const { store, files } = memoryStore();
    expect(await loadUpstream(SATCAT, store)).toBeUndefined();

    // A parser change can reject a stored file; the GP update then enriches without it.
    await storeUpstream(SATCAT, store, SATCAT_CSV, undefined, NOW);
    const gcatParserOnSatcat = { ...SATCAT, parse: parseGcatCatalog };
    expect(await loadUpstream(gcatParserOnSatcat, store)).toBeUndefined();

    files.set("satcat", new Uint8Array([1, 2, 3]));
    expect(await loadUpstream(SATCAT, store)).toBeUndefined();
  });
});
