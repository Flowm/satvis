// Everything under worker/src/gp/ must stay erasable syntax (no enums, namespaces,
// parameter properties or `import =`): the static generator imports it with node type stripping.

// CelesTrak OMM JSON record. Selection reads only OBJECT_NAME and NORAD_CAT_ID.
export interface OmmRecord {
  OBJECT_NAME?: string;
  NORAD_CAT_ID?: number | string;
  OBJECT_ID?: string;
  EPOCH?: string;
  [key: string]: unknown;
}

// Pseudo element sets (ot-add / otc-p1) with fake catalog numbers, which OMM cannot
// express. Carried through verbatim.
export interface TleRecord {
  OBJECT_NAME?: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
  // Attached by enrichRecords; OmmRecord admits it through its index signature.
  metadata?: Record<string, unknown>;
}

export type GpRecord = OmmRecord | TleRecord;

// Exactly one key is present.
export type SourceSpec = { celestrak: string } | { celestrakSup: string } | { url: string };

export interface GroupSelect {
  noradIds?: (number | string)[];
  names?: string[];
  namePattern?: string;
}

// One row per individually named satellite. Prefer it to select.noradIds + rename;
// `select` stays the tool for bulk and pattern selection.
export interface SatelliteSpec {
  // Matched against the record's NORAD_CAT_ID as a string, without normalization.
  noradId?: number;
  // Expected OBJECT_NAME: a mismatch with the noradId match warns. Without a noradId,
  // it is the selector (exact match).
  upstreamName?: string;
  // Display name. Omit to keep the upstream OBJECT_NAME.
  name?: string;
  // E.g. { swathStarboardKm: 205 }. The generator lifts it into the satellite table,
  // so it applies wherever the record is served, not just in this group.
  metadata?: Record<string, unknown>;
  // Suppresses the "matched no record" warning; a match warns instead.
  decayed?: boolean;
}

export interface GroupDefinition {
  // Served at /api/gp/<name>.json; must match ^[a-zA-Z0-9_-]+$.
  name: string;
  sources?: SourceSpec[];
  select?: GroupSelect;
  // Unioned with `select`. A row's `name` takes precedence over `rename`. A group
  // with neither `satellites` nor `select` passes every record, so its first row
  // filters it down to that row: use the top-level satellite table for those groups.
  satellites?: SatelliteSpec[];
  // OBJECT_NAME -> new name, applied after selection.
  rename?: Record<string, string>;
  // Groups whose full output, extras and renames included, is prepended to this
  // group's records. To order extras earlier, put them in a separate included group.
  include?: string[];
  // Groups whose records are removed from this group's whole output, includes and
  // extras too, matched by normalized satnum. A failed one fails this group.
  exclude?: string[];
  // Inlined by the generator from extraRecordsFile; appended verbatim.
  extraRecords?: GpRecord[];
  // What the user enables ("enable Weather"), served in the index. A group that
  // excludes others must share all its tags with them (the generator checks), so one
  // tag loads the whole.
  tags?: string[];
}

// A search-only group fills the catalog but gets no group row, being too large to enable whole.
export interface PresetGroup {
  name: string;
  searchOnly?: boolean;
}

// A route's starting configuration. `defaults` are query-string url parameters (ADR
// 0001); each client decodes them with its own codec and drops values it does not know.
export interface PresetDefinition {
  name: string;
  title?: string;
  description?: string;
  defaults?: Record<string, string>;
  groups: PresetGroup[];
}

// Matched by NORAD_CAT_ID alone; `name` is documentation only. The worker copies
// `metadata` opaquely; src/config/satelliteMetadata.ts gives it meaning.
export interface SatelliteEntry {
  noradId: number;
  name?: string;
  metadata: Record<string, unknown>;
  decayed?: boolean;
}

// The stored SATCAT, the second contributor to the satellite table (see satcat.ts).
export interface SatcatSnapshot {
  // The body's ETag, sent as If-None-Match next time. Absent when upstream sent none.
  validator?: string;
  updated: string;
  // satnum -> metadata bag, already renamed to the frontend's field names.
  rows: Record<string, Record<string, string>>;
}

// Served in /api/groups.json. push-gp reads `validator` from it to make its off-Worker
// download conditional.
export interface SatcatStatus {
  updated: string;
  count: number;
  validator?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface GroupsConfig {
  groups: GroupDefinition[];
  satellites?: SatelliteEntry[];
  presets?: PresetDefinition[];
}

// Stored in the KV index (gp:index).
export interface GroupStatus {
  name: string;
  updated: string | null;
  count: number;
  lastError?: string;
  lastErrorAt?: string;
  // Non-fatal `satellites` row issues from the last successful evaluation. Present only when non-empty.
  warnings?: string[];
  // From the config, not the refresh: see withConfig.
  tags?: string[];
}

export interface GroupsIndex {
  updated: string;
  groups: GroupStatus[];
  // From the config, not the refresh, keyed by preset name: see withConfig.
  presets?: Record<string, Omit<PresetDefinition, "name">>;
  // Absent until the first successful SATCAT fetch; kept, with lastError, when a later one fails.
  satcat?: SatcatStatus;
}
