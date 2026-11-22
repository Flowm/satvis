import { describe, expect, test } from "vitest";

import type { GranuleLayer } from "@/config/instrumentImagery";

import { passImagery, passTable, type RecordedOverpass, recordedFor, replaySteps } from "./passImagery";
import type { PassRow } from "./PassPredictor";

const MINUTE = 60 * 1000;
const layer = { token: "gibs:L", provider: "gibs", layer: "L", granules: ["C"], pictures: { provider: "gibs", layer: "L", frame: "granule" } } as unknown as GranuleLayer;

function recorded(start: number, end: number, { satellite = "NOAA 20", station = "Munich", day = true } = {}): RecordedOverpass {
  return { pair: `${satellite}|${station}`, satellite, station, layer, day, overpass: { start: start * MINUTE, end: end * MINUTE, granules: [] } };
}

function pass(start: number, end: number, name = "NOAA 20", groundStationName = "Munich") {
  return { name, groundStationName, start: start * MINUTE, end: end * MINUTE };
}

function row(p: ReturnType<typeof pass>): PassRow {
  return { key: `${p.name}-${p.start}`, name: p.name, countdown: "", startLabel: "", endLabel: "", primary: "1°", secondary: "2°", startMs: p.start };
}

describe("recordedFor", () => {
  test("takes the overlapping overpass of the pass's satellite and station, give or take two minutes", () => {
    const near = recorded(101, 109);
    expect(recordedFor(pass(100, 110), [recorded(100, 110, { station: "Kiruna" }), near])).toBe(near);
    expect(recordedFor(pass(100, 110), [recorded(111, 115)])).toBeDefined();
    expect(recordedFor(pass(100, 110), [recorded(113, 115)])).toBeUndefined();
  });

  test("of two, the one it overlaps most", () => {
    const most = recorded(104, 120);
    expect(recordedFor(pass(100, 110), [recorded(90, 101), most])).toBe(most);
  });
});

describe("passTable", () => {
  const options = { nowMs: 1000 * MINUTE, showPast: true, subject: "satellite" as const };

  test("gives each pass its recorded overpass, after the clock too, as in a replay", () => {
    const passes = [pass(100, 110), pass(1003, 1010), pass(2000, 2010)];
    const overpasses = [recorded(101, 109), recorded(1004, 1009)];
    const table = passTable(passes.map(row), passes, overpasses, options);
    expect(table.map((entry) => entry.recorded)).toEqual([overpasses[0], overpasses[1], undefined]);
    expect(table[0]).toMatchObject({ primary: "1°" });
  });

  test("adds the past day overpasses no pass is, by start, only with past passes shown", () => {
    const passes = [pass(500, 510)];
    const old = recorded(100, 110);
    const table = passTable(passes.map(row), passes, [old, recorded(200, 210, { day: false }), recorded(1500, 1510)], options);
    expect(table.map((entry) => entry.startMs)).toEqual([100 * MINUTE, 500 * MINUTE]);
    expect(table[0]).toMatchObject({ name: "NOAA 20", countdown: "ended", primary: "–", recorded: old });
    expect(passTable(passes.map(row), passes, [old], { ...options, showPast: false })).toHaveLength(1);
  });

  test("names an added row by its station where a satellite is selected", () => {
    expect(passTable([], [], [recorded(100, 110)], { ...options, subject: "station" })[0]).toMatchObject({ name: "Munich" });
  });

  test("adds no row for an overpass a pass overlaps, though the pass took another", () => {
    const passes = [pass(100, 130)];
    expect(passTable(passes.map(row), passes, [recorded(100, 125), recorded(128, 131)], options)).toHaveLength(1);
  });
});

describe("passImagery", () => {
  test("night, outlines alone, still asking, or how much GIBS has", () => {
    expect(passImagery(recorded(0, 1, { day: false }), [true])).toBe("night");
    expect(passImagery({ ...recorded(0, 1), layer: { ...layer, provider: "cmr", pictures: undefined } }, undefined)).toBe("outline");
    expect(passImagery(recorded(0, 1), undefined)).toBe("asking");
    expect(passImagery(recorded(0, 1), [true, true])).toBe("image");
    expect(passImagery(recorded(0, 1), [true, false])).toBe("part");
    expect(passImagery(recorded(0, 1), [false])).toBe("outline");
  });
});

describe("replaySteps", () => {
  const other = { ...layer, token: "gibs:M" } as GranuleLayer;

  test("steps through every satellite and station by day, by start", () => {
    const steps = [recorded(300, 310, { satellite: "NOAA 21" }), recorded(100, 110), recorded(200, 210, { station: "Kiruna" }), recorded(250, 260, { day: false })];
    expect(replaySteps(steps, steps[1]!).map((step) => step.overpass.start / MINUTE)).toEqual([100, 200, 300]);
  });

  test("keeps the started layer where a satellite has two over one station", () => {
    const started = recorded(100, 110);
    const twin = { ...started, layer: other };
    expect(replaySteps([twin, started], started)).toEqual([started]);
    expect(replaySteps([twin, started], twin)).toEqual([twin]);
  });
});
