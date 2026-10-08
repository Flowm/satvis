// Bookmarks: a link to a scene, kept under a name (docs/adr/0011-bookmarks.md). Pure:
// the store persists them, `useBookmarks` opens them.

import type { Query } from "./urlCodec";

/** A demo ships with the app, a saved one was named by the user, an opened one is a link that started a visit. */
export type BookmarkKind = "demo" | "saved" | "opened";

/** A link, with what a card needs to show it. */
export interface Bookmark {
  id: string;
  kind: BookmarkKind;
  name: string;
  /** The route it was made on, whose preset decides what an absent parameter means. */
  path: string;
  /** The url parameters the stores own (ADR 0001), defaults left out. */
  query: Query;
  /** A data url, or a path for a demo. */
  thumbnail?: string;
  /** When it was saved or opened, in epoch ms; 0 for a demo. */
  at: number;
}

/** What a card says under the name. */
export interface BookmarkSummary {
  /** Which satellites. */
  what: string;
  /** Where the camera is. */
  where: string;
  /** The pinned time, or undefined for live. */
  time?: string;
}

/** The newest opened links kept; older ones drop off. */
export const OPENED_LIMIT = 8;

/** Whether two queries say the same, whatever their order. */
export function sameQuery(a: Query, b: Query): boolean {
  const entries = (query: Query) =>
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .toSorted(([x], [y]) => x.localeCompare(y));
  return JSON.stringify(entries(a)) === JSON.stringify(entries(b));
}

/** Records a link a visit started with: newest first, once each, at most `OPENED_LIMIT`. */
export function withOpened(opened: readonly Bookmark[], link: Bookmark): Bookmark[] {
  return [link, ...opened.filter((other) => other.path !== link.path || !sameQuery(other.query, link.query))].slice(0, OPENED_LIMIT);
}

const list = (value: string | undefined): string[] => (value ? value.split(",") : []);

function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Up to two names, or a count. */
const satellitesNamed = (names: readonly string[]): string => (names.length <= 2 ? joinNames(names) : `${names.length} satellites`);

/** The first station of a `gs` value, which a link's sky view stands on, by name if it has one. */
function firstStation(gs: string): string {
  const [lat, lon, name] = gs.split("_")[0]!.split(",");
  return name || `${Number(lat).toFixed(2)}°, ${Number(lon).toFixed(2)}°`;
}

/** Day, month and minute in UTC, as the clock deck shows it, with the year only when it is not this one. */
function timeLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const year = date.getUTCFullYear() === now.getUTCFullYear() ? undefined : "numeric";
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year, timeZone: "UTC" })}, ${date.toISOString().slice(11, 16)} UTC`;
}

const PROJECTION: Readonly<Record<string, string>> = { "3D": "Globe", "2D": "Flat map", Columbus: "Columbus view" };

/**
 * What a bookmark shows, in words. `presetDefaults` fill what the query leaves out,
 * as they do when it is opened.
 */
export function summarize(query: Query, presetDefaults: Query, now = new Date()): BookmarkSummary {
  const value = (param: string): string | undefined => query[param] ?? presetDefaults[param];
  const tags = list(value("tags"));
  const sats = list(value("sats"));
  const track = value("track");

  let what: string;
  if (tags.length === 0) {
    what = sats.length === 0 ? "No satellites" : satellitesNamed(sats);
  } else {
    what = tags.length === 1 ? `${tags[0]} satellites` : joinNames(tags);
    if (sats.length > 0) {
      what += ` + ${satellitesNamed(sats)}`;
    }
  }

  const scene = value("scene") ?? "3D";
  const gs = value("gs");
  let where: string;
  if (scene === "Sky") {
    where = gs ? `Sky over ${firstStation(gs)}` : "Sky view";
  } else if (track) {
    // Under its own name, the satellite needs no second mention.
    where = what === track ? "Following it" : `Following ${track}`;
  } else {
    where = PROJECTION[scene] ?? scene;
  }

  const time = value("time");
  return { what, where, time: time ? timeLabel(time, now) : undefined };
}

/** A name for a scene nobody named: the camera where it says more than the satellites, both for a projection. */
export function defaultName({ what, where }: BookmarkSummary): string {
  if (where === "Globe") {
    return what;
  }
  if (where === "Following it") {
    return `Following ${what}`;
  }
  return where.startsWith("Following") || where.startsWith("Sky") ? where : `${what}, ${where.toLowerCase()}`;
}

/** The stored lists, or nothing for anything that is not one: storage is shared with every older build. */
export function parseBookmarks(json: string | null, kind: BookmarkKind): Bookmark[] {
  if (!json) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is Bookmark =>
        typeof item === "object" &&
        item !== null &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.path === "string" &&
        typeof item.at === "number" &&
        typeof item.query === "object" &&
        item.query !== null &&
        Object.values(item.query as object).every((v) => typeof v === "string") &&
        (item.thumbnail === undefined || typeof item.thumbnail === "string") &&
        item.kind === kind,
    );
  } catch {
    return [];
  }
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function timeAgo(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}
