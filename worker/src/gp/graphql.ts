// Minimal, dependency-free GraphQL endpoint for the GP data API.
//
// satvis ships a REST worker (/api/gp/<group>.json, /api/groups.json). This
// adds a GraphQL surface over the same KV data so a frontend can ask for
// exactly the fields it needs in one round trip, matching the kind of
// "integrated with a backend API" work the app's clients expect.
//
// Intentionally small: a hand-rolled parser for a fixed schema beats pulling
// graphql-js into a Cloudflare Worker for what the app actually queries.

import { GP_INDEX_KEY, GP_KEY_PREFIX, type GroupWriteMetadata } from "./store.ts";

export interface GpSatellite {
  name: string;
  line1?: string;
  line2?: string;
}

export interface GpGroup {
  name: string;
  updated?: string;
  count?: number;
  satellites: GpSatellite[];
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

// Read one group's records from KV. Returns null on miss or parse error.
async function readGroup(name: string, env: Env): Promise<GpGroup | null> {
  // Stored the same way the REST handler serves it: a JSON string under the
  // gp: prefix, so read as text and parse (getWithMetadata type:"json" would
  // misinterpret the text-encoded value).
  const { value, metadata } = await env.GP_KV.getWithMetadata<GroupWriteMetadata>(GP_KEY_PREFIX + name, {
    type: "text",
  });
  if (value === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  // The group is stored as the raw record array (what handleGroup serves), so
  // support both that and an object wrapping it under `records`.
  const records = Array.isArray(parsed) ? parsed : (parsed as { records?: unknown }).records;
  const satellites: GpSatellite[] = Array.isArray(records)
    ? records
        .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
        .map((r) => ({
          name: String(r.OBJECT_NAME ?? r.name ?? ""),
          line1: typeof r.TLE_LINE1 === "string" ? r.TLE_LINE1 : typeof r.line1 === "string" ? r.line1 : undefined,
          line2: typeof r.TLE_LINE2 === "string" ? r.TLE_LINE2 : typeof r.line2 === "string" ? r.line2 : undefined,
        }))
    : [];
  const updated = metadata && typeof metadata === "object" && "updated" in metadata ? (metadata as { updated?: string }).updated : undefined;
  return {
    name,
    updated,
    count: satellites.length,
    satellites,
  };
}

async function readIndex(env: Env): Promise<{ name: string; updated?: string; count?: number }[]> {
  const index = await env.GP_KV.get(GP_INDEX_KEY, "json");
  if (index === null || typeof index !== "object") {
    return [];
  }
  const groups = (index as { groups?: unknown }).groups;
  return Array.isArray(groups)
    ? (groups as { name: string; updated?: string; count?: number }[]).filter((g) => typeof g?.name === "string")
    : [];
}

// Parse `query { ... }` and return the names of the top-level fields requested.
// Good enough for the fixed schema below; refuses anything it does not
// recognise so a malformed body fails loudly instead of returning garbage.
function parseTopLevelFields(query: string): string[] {
  // Strip an optional leading `query Name` / `query` keyword, then take the
  // first balanced brace block as the selection set.
  const stripped = query.replace(/^\s*query\s*(?:[A-Za-z_]\w*)?\s*/, "");
  const start = stripped.indexOf("{");
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === "{") depth++;
    else if (stripped[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const body = stripped.slice(start + 1, end);
  // Top-level fields are comma-separated; splitting on whitespace would break
  // quoted arguments (e.g. group(name: "weather")), so split on commas only.
  const fields = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .split(/[{}]/)[0]
    ?.split(",")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => f.length > 0) ?? [];
  return fields;
}

// Resolve the requested top-level fields against the data.
async function resolveQuery(fields: string[], env: Env): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const wantGroups = fields.includes("groups");
  const groupField = fields.find((f) => f.startsWith("group("));
  const satelliteField = fields.find((f) => f.startsWith("satellite("));

  if (wantGroups) {
    result.groups = await readIndex(env);
  }
  if (groupField) {
    const name = /group\(\s*name:\s*"([^"]+)"\s*\)/.exec(groupField)?.[1];
    result.group = name ? await readGroup(name, env) : null;
  }
  if (satelliteField) {
    const name = /satellite\(\s*name:\s*"([^"]+)"\s*\)/.exec(satelliteField)?.[1];
    if (name) {
      // Satellites live inside their group records; scan every index group.
      const index = await readIndex(env);
      let found: GpSatellite | null = null;
      for (const g of index) {
        const group = await readGroup(g.name, env);
        const hit = group?.satellites.find((s) => s.name === name);
        if (hit) {
          found = hit;
          break;
        }
      }
      result.satellite = found;
    } else {
      result.satellite = null;
    }
  }
  return result;
}

export async function handleGraphql(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "POST") {
    return jsonResponse({ errors: [{ message: "Method Not Allowed" }] }, { status: 405, headers: { Allow: "POST" } });
  }
  let body: { query?: string; variables?: Record<string, unknown> };
  try {
    body = (await request.json()) as { query?: string };
  } catch {
    return jsonResponse({ errors: [{ message: "body is not valid JSON" }] }, { status: 400 });
  }
  const query = body?.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    return jsonResponse({ errors: [{ message: "missing query" }] }, { status: 400 });
  }
  const fields = parseTopLevelFields(query);
  if (fields.length === 0) {
    return jsonResponse({ errors: [{ message: "could not parse query" }] }, { status: 400 });
  }
  const data = await resolveQuery(fields, env);
  return jsonResponse({ data }, { headers: { "Cache-Control": "public, max-age=60" } });
}
