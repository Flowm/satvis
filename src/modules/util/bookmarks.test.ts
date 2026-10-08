import { describe, expect, test } from "vitest";

import { type Bookmark, defaultName, OPENED_LIMIT, parseBookmarks, sameLink, sameQuery, summarize, timeAgo, withOpened, withoutTime } from "./bookmarks";

const NOW = new Date("2026-10-08T12:00:00Z");
/** The `/` preset's. */
const DEFAULTS = { tags: "Weather" };

const opened = (query: Record<string, string>, path = "/"): Bookmark => ({ id: JSON.stringify(query), kind: "opened", name: "", path, query, at: 0 });

describe("summarize", () => {
  test("the default scene names the preset's satellites, on the globe, live", () => {
    expect(summarize({}, DEFAULTS, NOW)).toEqual({ what: "Weather satellites", where: "Globe", time: undefined });
  });

  test("a tracked satellite shown alone is not named twice", () => {
    const summary = summarize({ tags: "", sats: "ISS (ZARYA)", track: "ISS (ZARYA)", time: "2026-10-04T02:07Z" }, DEFAULTS, NOW);
    expect(summary).toEqual({ what: "ISS (ZARYA)", where: "Following it", time: "4 Oct, 02:07 UTC" });
    expect(defaultName(summary)).toBe("Following ISS (ZARYA)");
  });

  test("the sky view stands on the first station, by name or by coordinates", () => {
    expect(summarize({ scene: "Sky", gs: "46.5935,7.9091,Lauterbrunnen_48.1,11.5", tags: "GNSS,Weather,OneWeb" }, DEFAULTS, NOW)).toMatchObject({
      what: "GNSS, Weather and OneWeb",
      where: "Sky over Lauterbrunnen",
    });
    expect(summarize({ scene: "Sky", gs: "46.5935,7.9091" }, DEFAULTS, NOW).where).toBe("Sky over 46.59°, 7.91°");
  });

  test("satellites beside groups, and more than two of them, are counted", () => {
    expect(summarize({ sats: "A,B,C" }, DEFAULTS, NOW).what).toBe("Weather satellites + 3 satellites");
    expect(summarize({ tags: "", sats: "A,B" }, DEFAULTS, NOW).what).toBe("A and B");
    expect(summarize({ tags: "" }, DEFAULTS, NOW).what).toBe("No satellites");
  });

  test("a name for an unnamed scene", () => {
    expect(defaultName(summarize({}, DEFAULTS, NOW))).toBe("Weather satellites");
    expect(defaultName(summarize({ scene: "2D", tags: "Science" }, DEFAULTS, NOW))).toBe("Science satellites, flat map");
    expect(defaultName(summarize({ scene: "Sky", gs: "1,2,Home" }, DEFAULTS, NOW))).toBe("Sky over Home");
    expect(defaultName(summarize({ track: "NOAA 19" }, DEFAULTS, NOW))).toBe("Following NOAA 19");
  });

  test("a group named in the plural takes no noun", () => {
    expect(summarize({ tags: "Stations", track: "ISS (ZARYA)" }, DEFAULTS, NOW)).toMatchObject({ what: "Stations", where: "Following ISS (ZARYA)" });
    expect(summarize({ tags: "GNSS" }, DEFAULTS, NOW).what).toBe("GNSS satellites");
  });

  test("the preset fills what the query leaves out", () => {
    expect(summarize({}, { tags: "OT", scene: "2D" }, NOW)).toMatchObject({ what: "OT satellites", where: "Flat map" });
  });

  test("a time in another year names the year", () => {
    expect(summarize({ time: "2025-12-31T23:59Z" }, DEFAULTS, NOW).time).toBe("31 Dec 2025, 23:59 UTC");
  });
});

describe("withOpened", () => {
  test("puts the newest first and keeps each link once", () => {
    const a = opened({ tags: "GNSS" });
    const b = opened({ scene: "2D", tags: "Starlink" });
    const again = opened({ tags: "Starlink", scene: "2D" });
    expect(withOpened(withOpened([a], b), again).map((link) => link.id)).toEqual([again.id, a.id]);
  });

  test("tells the same query on two routes apart", () => {
    expect(withOpened([opened({ tags: "GNSS" }, "/ot")], opened({ tags: "GNSS" }))).toHaveLength(2);
  });

  test("drops the oldest past the limit", () => {
    let links: Bookmark[] = [];
    for (let i = 0; i < OPENED_LIMIT + 3; i++) {
      links = withOpened(links, opened({ sats: `SAT ${i}` }));
    }
    expect(links).toHaveLength(OPENED_LIMIT);
    expect(links[0]!.query.sats).toBe(`SAT ${OPENED_LIMIT + 2}`);
  });
});

test("withoutTime keeps the rest of the scene", () => {
  expect(withoutTime({ tags: "GNSS", time: "2026-10-05T11:00Z" })).toEqual({ tags: "GNSS" });
});

test("sameLink needs the same route and the same query", () => {
  expect(sameLink({ path: "/", query: { a: "1", b: "2" } }, { path: "/", query: { b: "2", a: "1" } })).toBe(true);
  expect(sameLink({ path: "/", query: { a: "1" } }, { path: "/ot", query: { a: "1" } })).toBe(false);
});

test("sameQuery ignores order", () => {
  expect(sameQuery({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
  expect(sameQuery({ a: "1" }, { a: "1", b: "" })).toBe(false);
});

describe("parseBookmarks", () => {
  const saved: Bookmark = { id: "1", kind: "saved", name: "Home", path: "/", query: { tags: "GNSS" }, at: 5 };

  test("reads what it wrote", () => {
    expect(parseBookmarks(JSON.stringify([saved]), "saved")).toEqual([saved]);
  });

  test("drops what it cannot use, and survives garbage", () => {
    expect(parseBookmarks(JSON.stringify([saved, { ...saved, query: { tags: 3 } }, { ...saved, kind: "opened" }, null, "x"]), "saved")).toEqual([saved]);
    expect(parseBookmarks("{", "saved")).toEqual([]);
    expect(parseBookmarks('{"a":1}', "saved")).toEqual([]);
    expect(parseBookmarks(null, "saved")).toEqual([]);
  });
});

test("timeAgo", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  expect(timeAgo(now - 30_000, now)).toBe("just now");
  expect(timeAgo(now - 5 * 60_000, now)).toBe("5 min ago");
  expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3 h ago");
  expect(timeAgo(now - 50 * 3_600_000, now)).toBe("2 d ago");
});
