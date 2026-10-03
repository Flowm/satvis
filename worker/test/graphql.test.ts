import { env, SELF } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";

import type { OmmRecord } from "../src/gp/types.ts";

const UPDATED = "2026-07-04T00:00:00.000Z";

function ommArray(...pairs: [string, number][]): OmmRecord[] {
  return pairs.map(([name, id], i) => ({
    OBJECT_NAME: name,
    NORAD_CAT_ID: id,
    TLE_LINE1: `1 ${id}U 24001A   ${i}000.00000000  .00000000  00000-0  00000-0 0  999`,
    TLE_LINE2: `2 ${id}  99.0000   0.0000 0000000   0.0000   0.0000 15.00000000    00`,
  }));
}

async function seedGroup(name: string, records: OmmRecord[], updated = UPDATED): Promise<void> {
  await env.GP_KV.put(`gp:${name}`, JSON.stringify(records), { metadata: { updated, count: records.length } });
}

async function seedIndex(): Promise<void> {
  await env.GP_KV.put(
    "gp:index",
    JSON.stringify({ updated: UPDATED, groups: [{ name: "weather", updated: UPDATED, count: 2 }] }),
  );
}

describe("POST /api/graphql", () => {
  beforeEach(async () => {
    await seedIndex();
    await seedGroup("weather", ommArray(["GOES 16", 41866], ["NOAA 20 (JPSS-1)", 43013]));
  });

  it("resolves the groups field from the index", async () => {
    const res = await SELF.fetch("https://satvis.space/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ groups { name count } }" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { groups?: { name: string; count?: number }[] } };
    expect(body.data?.groups).toEqual([expect.objectContaining({ name: "weather", count: 2 })]);
  });

  it("resolves a single group with its satellites", async () => {
    const res = await SELF.fetch("https://satvis.space/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: '{ group(name: "weather") { name count satellites { name } } }' }),
    });
    const body = (await res.json()) as {
      data?: { group?: { name: string; count?: number; satellites: { name: string }[] } | null };
    };
    expect(body.data?.group?.name).toBe("weather");
    expect(body.data?.group?.satellites.map((s) => s.name)).toEqual(["GOES 16", "NOAA 20 (JPSS-1)"]);
  });

  it("finds a satellite by name across groups", async () => {
    const res = await SELF.fetch("https://satvis.space/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: '{ satellite(name: "GOES 16") { name line1 } }' }),
    });
    const body = (await res.json()) as { data?: { satellite?: { name: string; line1?: string } | null } };
    expect(body.data?.satellite?.name).toBe("GOES 16");
    expect(body.data?.satellite?.line1).toContain("41866");
  });

  it("rejects a missing query with 400", async () => {
    const res = await SELF.fetch("https://satvis.space/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects GET with 405", async () => {
    const res = await SELF.fetch("https://satvis.space/api/graphql", { method: "GET" });
    expect(res.status).toBe(405);
  });
});
