// Shared GP (general perturbations) element-set types.
//
// IMPORTANT: This file (and everything else under worker/src/gp/) must stay
// node-type-strippable (erasable syntax only) because the static generator
// imports it with plain `node` (v24) type stripping. That means NO enums, NO
// namespaces, NO parameter properties, NO `import =` — only type-level syntax
// that erases cleanly to plain JS.

// CelesTrak OMM JSON record (GP element set). CelesTrak emits many optional
// fields; we only rely on OBJECT_NAME / NORAD_CAT_ID for selection, so the
// rest are kept as an open index signature.
export interface OmmRecord {
  OBJECT_NAME?: string;
  NORAD_CAT_ID?: number | string;
  OBJECT_ID?: string;
  EPOCH?: string;
  [key: string]: unknown;
}

// Escape hatch for pseudo element sets (ot-add / otc-p1) that use fake
// catalog numbers and cannot be expressed as OMM. Carried through the
// pipeline verbatim as two TLE lines.
export interface TleRecord {
  OBJECT_NAME?: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
  // Attached by enrichRecords, like on OmmRecord (which admits it via its index
  // signature). Lowercase to stand apart from the SCREAMING_SNAKE CCSDS fields.
  metadata?: Record<string, unknown>;
}

export type GpRecord = OmmRecord | TleRecord;

// A single upstream source for a group. Exactly one key is present.
export type SourceSpec = { celestrak: string } | { celestrakSup: string } | { url: string };

export interface GroupSelect {
  noradIds?: (number | string)[];
  names?: string[];
  namePattern?: string;
}

// One row per satellite, co-locating its NORAD id, expected upstream name, and
// display-name override so a renamed satellite's three facts live together
// instead of being scattered across select.noradIds / rename. Preferred over
// select.noradIds+rename for known, individually-named satellites; select is
// still the tool for bulk/pattern selection.
export interface SatelliteSpec {
  // Primary selector — matched against NORAD_CAT_ID (numeric-normalized).
  noradId?: number;
  // Expected upstream OBJECT_NAME. Documents the satellite, validates the id
  // match (mismatch -> warning), and acts as the selector when noradId is
  // absent (exact OBJECT_NAME match).
  upstreamName?: string;
  // Display-name override. Omit to keep the upstream OBJECT_NAME.
  name?: string;
  // Optional per-satellite metadata (e.g. { swathStarboardKm: 205 }); the
  // generator lifts this into the merged satellite table, keyed by noradId, so
  // it applies wherever the record is served — not just in this group.
  metadata?: Record<string, unknown>;
  // The satellite has decayed and is expected to match no record ever again.
  // Suppresses the "matched no record" warning; a match warns in reverse.
  decayed?: boolean;
}

export interface GroupDefinition {
  // Served at /api/gp/<name>.json — must match ^[a-zA-Z0-9_-]+$.
  name: string;
  sources?: SourceSpec[];
  select?: GroupSelect;
  // Per-satellite rows, unioned with `select`. A row matches by noradId when
  // present, else by exact upstreamName. A row's `name` renames the records it
  // matched (taking precedence over the group-level `rename` map).
  //
  // A group with neither `satellites` nor `select` passes every record through,
  // so adding the first row to one filters it down to just that row. Use the
  // top-level satellite table for a fact about a satellite in a pass-all group.
  satellites?: SatelliteSpec[];
  // OBJECT_NAME -> new name, applied post-select.
  rename?: Record<string, string>;
  // Names of other groups whose FULL evaluated output — including their own
  // extraRecords and renames — is prepended before this group's own records
  // (they are evaluated first). This differs from the old ot-tle sync.sh, which
  // concatenated ot.txt into wfs.txt BEFORE appending ot-add.txt extras; authors
  // who want that ordering should put extras in a separate included group.
  include?: string[];
  // Names of other groups whose records are removed from this group's final
  // output, includes and extras too, matched by normalized satnum. Evaluated
  // first like an include, and a failed one fails this group.
  exclude?: string[];
  // Inlined by the generator from extraRecordsFile; appended verbatim.
  extraRecords?: GpRecord[];
  // What the user enables to show this group's satellites ("enable Weather").
  // Served in the index for clients to group and activate by. A group that
  // excludes others must share every one of its tags with them (the generator
  // checks), so that one tag loads the whole.
  tags?: string[];
}

// One group a preset registers. A search-only group fills the catalog but gets
// no group row: it is too large to be worth enabling whole.
export interface PresetGroup {
  name: string;
  searchOnly?: boolean;
}

// A route's starting configuration, shared by every client. `defaults` are url
// parameters in the vocabulary of docs/adr/0001-url-parameter-specification.md,
// as they would appear in a query string. Each client decodes them with its own
// codec and drops the values it does not know.
export interface PresetDefinition {
  name: string;
  title?: string;
  description?: string;
  defaults?: Record<string, string>;
  groups: PresetGroup[];
}

// One row of the satellite table: static facts about a satellite, matched
// against a record's NORAD_CAT_ID alone. `name` is documentation only.
//
// The worker treats `metadata` as opaque JSON — it copies the bag onto matching
// records without interpreting it, so new fields need no worker change. The
// frontend gives it meaning (see src/config/satelliteMetadata.ts).
export interface SatelliteEntry {
  noradId: number;
  name?: string;
  metadata: Record<string, unknown>;
  decayed?: boolean;
}

// The CelesTrak SATCAT as we keep it: the second contributor to the satellite
// table (see satcat.ts), stored rather than re-fetched every refresh.
//
// `rows` is satnum -> the same opaque bag a curated entry carries, already
// projected down to the fields we serve (owner, launchDate, launchSite,
// opsStatus, orbitType, orbitCenter, decayDate — SATCAT's own column names are
// not the frontend's vocabulary, so the rename happens at parse time).
//
// `validator` is the ETag of the body these rows came from, replayed as
// If-None-Match on the next fetch. Absent when upstream sent no ETag, which
// simply costs a full download next time.
export interface SatcatSnapshot {
  validator?: string;
  updated: string;
  rows: Record<string, Record<string, string>>;
}

// SATCAT status for the KV index, so GET /api/groups.json can report what the
// stored catalog holds — and so push-gp can read the validator it needs to make
// its own download conditional (it fetches off-Worker; see push-gp.mjs).
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

// Per-group status entry stored in the KV index (gp:index).
export interface GroupStatus {
  name: string;
  updated: string | null;
  count: number;
  lastError?: string;
  lastErrorAt?: string;
  // Non-fatal issues from the last successful evaluation (e.g. a satellites row
  // whose id matched a record with an unexpected OBJECT_NAME, or whose id
  // matched no record at all). Present only when non-empty.
  warnings?: string[];
  // From the config, not the refresh: see withConfig.
  tags?: string[];
}

export interface GroupsIndex {
  updated: string;
  groups: GroupStatus[];
  // From the config, not the refresh, keyed by preset name: see withConfig.
  presets?: Record<string, Omit<PresetDefinition, "name">>;
  // Absent until the first successful SATCAT fetch, and left in place (with
  // lastError set) when a later one fails.
  satcat?: SatcatStatus;
}
