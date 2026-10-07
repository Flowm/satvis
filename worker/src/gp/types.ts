// Everything under worker/src/gp/ must stay erasable syntax (no enums, namespaces,
// parameter properties or `import =`): the static generator imports it with node type stripping.

/** CelesTrak OMM JSON record. Selection reads only OBJECT_NAME and NORAD_CAT_ID. */
export interface OmmRecord {
  OBJECT_NAME?: string;
  NORAD_CAT_ID?: number | string;
  OBJECT_ID?: string;
  EPOCH?: string;
  [key: string]: unknown;
}

/**
 * Pseudo element sets (ot-add / otc-p1) with fake catalog numbers, which OMM cannot
 * express. Carried through verbatim.
 */
export interface TleRecord {
  OBJECT_NAME?: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
  /** Attached by SatelliteTable.enrich; OmmRecord admits it through its index signature. */
  metadata?: Record<string, unknown>;
}

export type GpRecord = OmmRecord | TleRecord;

/** Exactly one key is present. */
export type SourceSpec = { celestrak: string } | { celestrakSup: string } | { url: string };

export interface GroupSelect {
  noradIds?: (number | string)[];
  names?: string[];
  namePattern?: string;
}

/**
 * One row per individually named satellite. Prefer it to select.noradIds + rename;
 * `select` stays the tool for bulk and pattern selection.
 */
export interface SatelliteSpec {
  /** Matched against the record's NORAD_CAT_ID as a string, without normalization. */
  noradId?: number;
  /**
   * Expected OBJECT_NAME: a mismatch with the noradId match warns. Without a noradId,
   * it is the selector (exact match).
   */
  upstreamName?: string;
  /** Display name. Omit to keep the upstream OBJECT_NAME. */
  name?: string;
  /**
   * E.g. { swathStarboardKm: 205 }. The generator lifts it into the satellite table,
   * so it applies wherever the record is served, not just in this group.
   */
  metadata?: Record<string, unknown>;
  /** Suppresses the "matched no record" warning; a match warns instead. */
  decayed?: boolean;
}

export interface GroupDefinition {
  /** Served at /api/gp/<name>.json; must match ^[a-zA-Z0-9_-]+$. */
  name: string;
  sources?: SourceSpec[];
  select?: GroupSelect;
  /**
   * Unioned with `select`. A row's `name` takes precedence over `rename`. A group
   * with neither `satellites` nor `select` passes every record, so its first row
   * filters it down to that row: use the top-level satellite table for those groups.
   */
  satellites?: SatelliteSpec[];
  /** OBJECT_NAME -> new name, applied after selection. */
  rename?: Record<string, string>;
  /**
   * Groups whose full output, extras and renames included, is prepended to this
   * group's records. To order extras earlier, put them in a separate included group.
   */
  include?: string[];
  /**
   * Groups whose records are removed from this group's whole output, includes and
   * extras too, matched by normalized satnum. A failed one fails this group.
   */
  exclude?: string[];
  /** Inlined by the generator from extraRecordsFile; appended verbatim. */
  extraRecords?: GpRecord[];
  /**
   * What the user enables ("enable Weather"), served in the index. A group that
   * excludes others must share all its tags with them (the generator checks), so one
   * tag loads the whole.
   */
  tags?: string[];
}

/** A search-only group fills the catalog but gets no group row, being too large to enable whole. */
export interface PresetGroup {
  name: string;
  searchOnly?: boolean;
}

/**
 * A route's starting configuration. `defaults` are query-string url parameters (ADR
 * 0001); each client decodes them with its own codec and drops values it does not know.
 */
export interface PresetDefinition {
  name: string;
  title?: string;
  description?: string;
  defaults?: Record<string, string>;
  groups: PresetGroup[];
}

/**
 * Matched by NORAD_CAT_ID alone; `name` is documentation only. The worker copies
 * `metadata` opaquely; src/config/satelliteMetadata.ts gives it meaning.
 */
export interface SatelliteEntry {
  noradId: number;
  name?: string;
  metadata: Record<string, unknown>;
  decayed?: boolean;
}

/**
 * A table downloaded whole and stored as the file it is (upstream.ts, ADR 0008): SATCAT,
 * and GCAT's catalog, organisations and payloads. Each name is the key of its file and
 * its status, and its entry in /api/status.
 */
export type UpstreamName = "satcat" | "gcat" | "gcatOrgs" | "gcatPayloads";

/** satnum -> metadata bag, already renamed to the frontend's field names (satcat.ts). */
export type SatcatRows = Record<string, Record<string, string>>;

/**
 * One GCAT catalog row (gcat.ts). `country`, `manufacturer` and `operator` are still
 * GCAT codes here: they become names when the satellite table is built.
 */
export interface GcatRow {
  /** GCAT's own id, which the payload table is keyed by. Not served. */
  jcat: string;
  /** `State`: a country or intergovernmental code (`US`, `I-ESA`). */
  country?: string;
  /** `Bus`, as GCAT spells it: "Starlink V2M". */
  bus?: string;
  /** `Manufacturer`: organisation codes, several joined with "/". */
  manufacturer?: string;
  /** `Owner`: the operating organisation's code. */
  operator?: string;
  /** Launch mass, kg. */
  massKg?: number;
  /** Metres: the body's longest dimension. */
  lengthM?: number;
  /** Metres: the body's second dimension. */
  diameterM?: number;
  /** Metres: the extent with arrays and booms. */
  spanM?: number;
  /** Free text, spaces collapsed: "Box + 2 Pan". */
  shape?: string;
  /** The keys GCAT flags as estimated. */
  estimated?: string[];
}

/** satnum -> catalog row. */
export type GcatRows = Record<string, GcatRow>;

/** GCAT organisation or country code -> display name. */
export type GcatOrgNames = Record<string, string>;

/** JCAT -> the payload table's codes, labelled by the frontend (src/config/gcatCodes.ts). */
export type GcatPayloadRows = Record<string, { category?: string; class?: string }>;

/**
 * Stored as KV metadata on `status:<name>`, apart from the file, so a 304 or a failure
 * is recorded without rewriting it. Served in /api/status, where push-catalog reads
 * `etag` to make its download conditional.
 */
export interface UpstreamStatus {
  /** When the stored file was last replaced. */
  updated?: string;
  /**
   * When upstream last answered with a file or a 304. A failure leaves it, so a table
   * that keeps failing goes stale.
   */
  checked?: string;
  /** The stored file's ETag, sent as If-None-Match next time. */
  etag?: string;
  /** The stored file's size, uncompressed. */
  bytes?: number;
  /** How many rows the stored file parsed to. */
  rows?: number;
  /** The last failure since upstream last answered, a download's or a refused file's. */
  lastError?: string;
  lastErrorAt?: string;
}

export interface GroupsConfig {
  groups: GroupDefinition[];
  satellites?: SatelliteEntry[];
  presets?: PresetDefinition[];
  /**
   * GCAT bus -> modelFile, from the model manifests' `buses` (ADR 0007). Applied at
   * refresh time to a satellite whose GCAT bus is listed and no manifest lists by NORAD id.
   */
  modelBuses?: Record<string, string>;
}

/** Stored in the KV index (gp:index). */
export interface GroupStatus {
  name: string;
  updated: string | null;
  count: number;
  lastError?: string;
  lastErrorAt?: string;
  /**
   * Non-fatal `satellites` row issues from the last successful evaluation. Present only when non-empty.
   */
  warnings?: string[];
  /** From the config, not the refresh: see withConfig. */
  tags?: string[];
}

export interface GroupsIndex {
  updated: string;
  groups: GroupStatus[];
  /** From the config, not the refresh, keyed by preset name: see withConfig. */
  presets?: Record<string, Omit<PresetDefinition, "name">>;
}
