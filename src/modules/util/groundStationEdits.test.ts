import { describe, expect, test } from "vitest";

import type { SerializedGroundStation } from "../../stores/sat";
import {
  dragShift,
  dropIndex,
  MAX_LATITUDE,
  MAX_LONGITUDE,
  moved,
  observerAfterMove,
  observerAfterRemoval,
  parseCoordinate,
  relocated,
  renamed,
  repositioned,
  without,
} from "./groundStationEdits";

const list = (): SerializedGroundStation[] => [
  { lat: 48.1372, lon: 11.5756, name: "Munich" },
  { lat: 51.5074, lon: -0.1278 },
  { lat: -33.8688, lon: 151.2093, name: "Sydney" },
];

describe("parseCoordinate", () => {
  test("takes a coordinate however it is written", () => {
    expect(parseCoordinate("48.1372", MAX_LATITUDE)).toBe(48.1372);
    expect(parseCoordinate("-0.1278", MAX_LONGITUDE)).toBe(-0.1278);
    expect(parseCoordinate("  11.5756  ", MAX_LONGITUDE)).toBe(11.5756);
    expect(parseCoordinate("0", MAX_LATITUDE)).toBe(0);
  });

  test("refuses what is still being typed", () => {
    expect(parseCoordinate("", MAX_LATITUDE)).toBeUndefined();
    expect(parseCoordinate("-", MAX_LATITUDE)).toBeUndefined();
    expect(parseCoordinate(".", MAX_LATITUDE)).toBeUndefined();
  });

  test("refuses what is not a place", () => {
    expect(parseCoordinate("banana", MAX_LATITUDE)).toBeUndefined();
    expect(parseCoordinate("91", MAX_LATITUDE)).toBeUndefined();
    expect(parseCoordinate("-90.001", MAX_LATITUDE)).toBeUndefined();
    expect(parseCoordinate("181", MAX_LONGITUDE)).toBeUndefined();
    expect(parseCoordinate("90", MAX_LATITUDE)).toBe(90);
    expect(parseCoordinate("-180", MAX_LONGITUDE)).toBe(-180);
  });

  test("does not read a typo as a number", () => {
    expect(parseCoordinate("48abc", MAX_LATITUDE)).toBeUndefined();
  });
});

describe("dropIndex", () => {
  const ROW = 26;

  test("swaps at the halfway point of a neighbour, not after clearing it", () => {
    expect(dropIndex(0, ROW * 0.4, ROW, 3)).toBe(0);
    expect(dropIndex(0, ROW * 0.6, ROW, 3)).toBe(1);
  });

  test("mirrors: dragging up half a row does what dragging down half a row does", () => {
    expect(dropIndex(0, ROW * 1.5, ROW, 4)).toBe(2);
    expect(dropIndex(3, -ROW * 1.5, ROW, 4)).toBe(1);
    expect(dropIndex(2, -ROW * 1.5, ROW, 3)).toBe(0);
  });

  test("stops at the ends of the list", () => {
    expect(dropIndex(0, -500, ROW, 3)).toBe(0);
    expect(dropIndex(0, 500, ROW, 3)).toBe(2);
    expect(dropIndex(2, 500, ROW, 3)).toBe(2);
  });

  test("a row that has not really moved lands where it started", () => {
    // So a tap on the handle is a no-op.
    expect(dropIndex(1, 0, ROW, 3)).toBe(1);
    expect(dropIndex(1, 3, ROW, 3)).toBe(1);
  });

  test("survives a row height nobody could measure", () => {
    expect(dropIndex(1, 40, 0, 3)).toBe(1);
  });
});

describe("dragShift", () => {
  const ROW = 26;

  test("parts the list where the dragged row will land", () => {
    expect(dragShift(1, 0, 2, ROW)).toBe(-ROW);
    expect(dragShift(2, 0, 2, ROW)).toBe(-ROW);
    expect(dragShift(0, 2, 0, ROW)).toBe(ROW);
    expect(dragShift(1, 2, 0, ROW)).toBe(ROW);
  });

  test("leaves the rows the drag never reaches alone", () => {
    expect(dragShift(3, 0, 2, ROW)).toBe(0);
    expect(dragShift(0, 1, 2, ROW)).toBe(0);
  });

  test("does not shift the dragged row, which follows the pointer instead", () => {
    expect(dragShift(1, 1, 2, ROW)).toBe(0);
  });

  test("shifts nothing while the drag is still over its own row", () => {
    expect(dragShift(0, 1, 1, ROW)).toBe(0);
    expect(dragShift(2, 1, 1, ROW)).toBe(0);
  });
});

describe("moved", () => {
  test("promotes a station to the front, which is what makes it the observer", () => {
    expect(moved(list(), 1, -1).map((station) => station.lat)).toEqual([51.5074, 48.1372, -33.8688]);
  });

  test("moves down", () => {
    expect(moved(list(), 0, 1).map((station) => station.lat)).toEqual([51.5074, 48.1372, -33.8688]);
  });

  test("stays put at the ends", () => {
    expect(moved(list(), 0, -1)).toEqual(list());
    expect(moved(list(), 2, 1)).toEqual(list());
  });

  test("hands back copies, so the store sees a change at all", () => {
    const before = list();
    const after = moved(before, 1, -1);
    expect(after[1]).not.toBe(before[0]);
    expect(after[1]).toEqual(before[0]);
  });
});

describe("without", () => {
  test("drops the one asked for and nothing else", () => {
    expect(without(list(), 1).map((station) => station.name)).toEqual(["Munich", "Sydney"]);
  });

  test("ignores an index that is not there", () => {
    expect(without(list(), 9)).toEqual(list());
  });
});

describe("renamed", () => {
  test("renames one station", () => {
    expect(renamed(list(), 2, "Sydney Harbour")[2]).toEqual({ lat: -33.8688, lon: 151.2093, name: "Sydney Harbour" });
  });

  test("trims, because a name of spaces is not a name", () => {
    expect(renamed(list(), 0, "  Munich  ")[0]?.name).toBe("Munich");
  });

  test("clearing the name removes it rather than storing an empty one", () => {
    expect(renamed(list(), 0, "")[0]).toEqual({ lat: 48.1372, lon: 11.5756 });
    expect(renamed(list(), 0, "   ")[0]).not.toHaveProperty("name");
  });
});

describe("relocated", () => {
  test("replaces one coordinate and keeps the rest of the station", () => {
    expect(relocated(list(), 0, "lat", 49)[0]).toEqual({ lat: 49, lon: 11.5756, name: "Munich" });
    expect(relocated(list(), 1, "lon", 12)[1]).toEqual({ lat: 51.5074, lon: 12 });
  });

  test("leaves every other station alone", () => {
    expect(relocated(list(), 0, "lat", 49).slice(1)).toEqual(list().slice(1));
  });
});

describe("repositioned", () => {
  test("replaces both coordinates in one step and keeps the name", () => {
    expect(repositioned(list(), 0, 49, 12)[0]).toEqual({ lat: 49, lon: 12, name: "Munich" });
  });

  test("leaves every other station alone, and an index off the end changes nothing", () => {
    expect(repositioned(list(), 0, 49, 12).slice(1)).toEqual(list().slice(1));
    expect(repositioned(list(), 9, 49, 12)).toEqual(list());
  });
});

describe("observerAfterMove", () => {
  test("follows the station being dragged", () => {
    expect(observerAfterMove(0, 0, 2, 4)).toBe(2);
    expect(observerAfterMove(3, 3, -3, 4)).toBe(0);
  });

  test("steps aside for a station dragged past it", () => {
    expect(observerAfterMove(1, 0, 1, 3)).toBe(0);
    expect(observerAfterMove(1, 2, -2, 3)).toBe(2);
  });

  test("ignores a drag that happens entirely past it", () => {
    expect(observerAfterMove(0, 1, 1, 4)).toBe(0);
    expect(observerAfterMove(3, 0, 1, 4)).toBe(3);
  });

  test("refuses a drag that would leave the list, exactly as moved does", () => {
    expect(observerAfterMove(2, 0, -1, 3)).toBe(2);
    expect(observerAfterMove(2, 2, 1, 3)).toBe(2);
    expect(moved(list(), 0, -1)).toEqual(list());
  });
});

describe("observerAfterRemoval", () => {
  test("closes the gap when a station ahead of it goes", () => {
    expect(observerAfterRemoval(2, 0, 3)).toBe(1);
    expect(observerAfterRemoval(2, 1, 3)).toBe(1);
  });

  test("stays put when a station behind it goes", () => {
    expect(observerAfterRemoval(0, 1, 3)).toBe(0);
    expect(observerAfterRemoval(1, 2, 3)).toBe(1);
  });

  test("falls back to the first station when the observer itself goes", () => {
    expect(observerAfterRemoval(2, 2, 3)).toBe(0);
  });

  test("never returns an index the shortened list cannot hold", () => {
    for (let count = 1; count <= 4; count += 1) {
      for (let observer = 0; observer < count; observer += 1) {
        for (let index = 0; index < count; index += 1) {
          expect(observerAfterRemoval(observer, index, count)).toBeLessThan(Math.max(1, count - 1));
        }
      }
    }
  });
});
