import { JulianDate } from "@cesium/core";
import dayjs from "dayjs";
import { describe, expect, test } from "vitest";

import { PassPredictor, filterPasses, formatCountdown, passMinutes, passQuality, passSummary, stationPasses, toPassRows, type GroundStation, type Pass } from "./PassPredictor";
import { parseGpPayload, type GpRecord } from "./util/gp";
import { InlinePassSource, type PassPredictorSource, type PassQuery } from "./util/passSource";

const T0 = Date.UTC(2026, 6, 1, 12, 0, 0); // 2026-07-01T12:00:00Z
const NOW = JulianDate.fromDate(new Date(T0));

function elevationPass(startOffsetMs: number, endOffsetMs: number, groundStationName = "Munich"): Pass {
  return {
    name: "ISS",
    start: T0 + startOffsetMs,
    end: T0 + endOffsetMs,
    duration: endOffsetMs - startOffsetMs,
    azimuthStart: 10,
    azimuthApex: 123.456,
    azimuthEnd: 200,
    maxElevation: 56.7,
    groundStationName,
  };
}

function swathPass(startOffsetMs: number, endOffsetMs: number): Pass {
  return {
    name: "ISS",
    start: T0 + startOffsetMs,
    end: T0 + endOffsetMs,
    duration: endOffsetMs - startOffsetMs,
    minDistance: 12.34,
    minDistanceTime: T0 + startOffsetMs,
    swathWidth: 1234.5,
    groundStationName: "Munich",
  };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

/** Time near the TLE epoch so SGP4 propagation stays meaningful. */
const EPOCH_TIME = JulianDate.fromDate(dayjs("2018-12-08").toDate());

const MUNICH: GroundStation = { name: "Munich", position: { latitude: 48.177, longitude: 11.7476, height: 0 } };
const VIENNA: GroundStation = { name: "Vienna", position: { latitude: 48.2082, longitude: 16.3738, height: 0 } };

/** Records every query. */
function issPredictor(swathKm = 500): { predictor: PassPredictor; queries: PassQuery[] } {
  const record = parseGpPayload(TLE)[0] as GpRecord;
  const bound = new InlinePassSource().predictorFor("ISS", record);
  const queries: PassQuery[] = [];
  const source: PassPredictorSource = {
    passes: (query) => {
      queries.push(query);
      return bound.passes(query);
    },
  };
  // The symmetric split SatelliteProperties gives a satellite without per-side extents.
  const predictor = new PassPredictor({ starboardKm: swathKm / 2, portKm: swathKm / 2 }, source);
  return { predictor, queries };
}

/** Lets every reply already asked for land: the inline source answers before the next task. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The passes at `time`, once the read's reply has landed. */
async function passesAt(predictor: PassPredictor, time: JulianDate): Promise<Pass[]> {
  predictor.passes(time);
  await settle();
  return predictor.passes(time);
}

describe("PassPredictor", () => {
  test("asks for nothing without a ground station", async () => {
    const { predictor, queries } = issPredictor();
    expect(await passesAt(predictor, EPOCH_TIME)).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });

  test("computes passes with the station name attached and intervals in sync", async () => {
    const { predictor } = issPredictor();
    predictor.groundStations = [MUNICH];
    const passes = await passesAt(predictor, EPOCH_TIME);
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.every((pass) => pass.groundStationName === "Munich")).toBe(true);
    expect(passes.every((pass) => pass.name === "ISS")).toBe(true);
    expect(predictor.passIntervals.length).toBe(passes.length);
  });

  test("a read before the answer lands is empty rather than blocking", async () => {
    const { predictor } = issPredictor();
    predictor.groundStations = [MUNICH];

    expect(predictor.passes(EPOCH_TIME)).toHaveLength(0);

    await settle();
    expect(predictor.passes(EPOCH_TIME).length).toBeGreaterThan(0);
  });

  test("asks again only when time leaves the pass window", async () => {
    const { predictor, queries } = issPredictor();
    predictor.groundStations = [MUNICH];

    await passesAt(predictor, EPOCH_TIME);
    expect(queries).toHaveLength(1);

    // Inside the ±1 day window: no new request.
    await passesAt(predictor, JulianDate.addSeconds(EPOCH_TIME, 3600, new JulianDate()));
    expect(queries).toHaveLength(1);

    // A jump beyond the window forces one.
    await passesAt(predictor, JulianDate.addDays(EPOCH_TIME, 2, new JulianDate()));
    expect(queries).toHaveLength(2);
  });

  test("only one request is outstanding, however many reads arrive", async () => {
    const { predictor, queries } = issPredictor();
    predictor.groundStations = [MUNICH];

    predictor.passes(EPOCH_TIME);
    predictor.passes(JulianDate.addDays(EPOCH_TIME, 3, new JulianDate()));
    predictor.passes(JulianDate.addDays(EPOCH_TIME, 5, new JulianDate()));
    await settle();

    // Three reads, two requests: the one already out, then one re-ask for the latest time.
    expect(queries).toHaveLength(2);
    expect(queries[1]!.startEpochMs).toBeGreaterThan(queries[0]!.startEpochMs);
  });

  test("changing ground stations clears the computed passes", async () => {
    const { predictor } = issPredictor();
    predictor.groundStations = [MUNICH];
    expect((await passesAt(predictor, EPOCH_TIME)).length).toBeGreaterThan(0);

    predictor.groundStations = [];
    expect(await passesAt(predictor, EPOCH_TIME)).toHaveLength(0);
    expect(predictor.passIntervals.length).toBe(0);
  });

  test("a reply computed against stations that have since changed is dropped", async () => {
    const { predictor, queries } = issPredictor();
    predictor.groundStations = [MUNICH];
    predictor.passes(EPOCH_TIME);

    // The station goes away while the request is out.
    predictor.groundStations = [];
    await settle();

    expect(queries).toHaveLength(1);
    expect(predictor.passes(EPOCH_TIME)).toHaveLength(0);
    expect(predictor.passIntervals.length).toBe(0);
  });

  test("swath mode asks with the per-side extents", async () => {
    const { predictor, queries } = issPredictor(290);
    predictor.groundStations = [MUNICH];

    predictor.mode = "swath";
    const passes = await passesAt(predictor, EPOCH_TIME);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.mode).toBe("swath");
    expect(queries[0]!.swath).toEqual({ starboardKm: 145, portKm: 145 });
    expect(passes.every((pass) => "minDistance" in pass)).toBe(true);
  });

  test("setting the same mode keeps the window intact", async () => {
    const { predictor, queries } = issPredictor();
    predictor.groundStations = [MUNICH];
    await passesAt(predictor, EPOCH_TIME);

    predictor.mode = "elevation";
    await passesAt(predictor, EPOCH_TIME);
    expect(queries).toHaveLength(1);
  });

  test("notifies listeners when a pass list lands", async () => {
    const { predictor } = issPredictor();
    predictor.groundStations = [MUNICH];
    let notified = 0;
    const unsubscribe = predictor.onChanged(() => {
      notified += 1;
    });

    await passesAt(predictor, EPOCH_TIME);
    expect(notified).toBe(1);

    unsubscribe();
    await passesAt(predictor, JulianDate.addDays(EPOCH_TIME, 2, new JulianDate()));
    expect(notified).toBe(1);
  });
});

describe("stationPasses", () => {
  test("keeps only the named station's passes, sorted by start", async () => {
    const { predictor } = issPredictor();
    predictor.groundStations = [MUNICH, VIENNA];
    const all = await passesAt(predictor, EPOCH_TIME);
    expect(all.some((pass) => pass.groundStationName === "Vienna")).toBe(true);

    const munich = stationPasses([predictor], EPOCH_TIME, "Munich");
    expect(munich.length).toBeGreaterThan(0);
    expect(munich.every((pass) => pass.groundStationName === "Munich")).toBe(true);
    expect(munich).toEqual(munich.toSorted((a, b) => a.start - b.start));
  });

  test("drops passes starting beyond the deltaHours horizon", async () => {
    const { predictor } = issPredictor();
    predictor.groundStations = [MUNICH];
    await passesAt(predictor, EPOCH_TIME);
    const horizon = stationPasses([predictor], EPOCH_TIME, "Munich", 1);
    const startLimit = JulianDate.toDate(EPOCH_TIME).getTime() + 2 * HOUR;
    expect(horizon.every((pass) => pass.start < startLimit)).toBe(true);
  });
});

describe("filterPasses", () => {
  test("drops passes that have already ended", () => {
    const passes = [elevationPass(-2 * HOUR, -1 * HOUR), elevationPass(-5 * MIN, 5 * MIN), elevationPass(1 * HOUR, 2 * HOUR)];
    const upcoming = filterPasses(passes, NOW, false);
    expect(upcoming).toHaveLength(2);
    expect(upcoming[0]!.start).toBe(T0 - 5 * MIN);
  });

  test("drops an ended pass interleaved after an ongoing one", () => {
    // Aggregated ground-station lists are sorted by start, so a finished pass
    // of one satellite can follow the ongoing pass of another.
    const passes = [elevationPass(-2 * HOUR, 5 * MIN), elevationPass(-90 * MIN, -1 * HOUR), elevationPass(1 * HOUR, 2 * HOUR)];
    const upcoming = filterPasses(passes, NOW, false);
    expect(upcoming).toHaveLength(2);
    expect(upcoming.every((pass) => pass.end > T0)).toBe(true);
  });

  test("returns empty array when all passes are over", () => {
    const passes = [elevationPass(-2 * HOUR, -1 * HOUR)];
    expect(filterPasses(passes, NOW, false)).toHaveLength(0);
  });

  test("keeps every pass when past passes are shown", () => {
    const passes = [elevationPass(-2 * HOUR, -1 * HOUR), elevationPass(-5 * MIN, 5 * MIN), elevationPass(1 * HOUR, 2 * HOUR)];
    expect(filterPasses(passes, NOW, true)).toHaveLength(3);
  });
});

describe("formatCountdown", () => {
  test("ongoing and ended passes are named rather than counted", () => {
    expect(formatCountdown(T0, elevationPass(-5 * MIN, 5 * MIN))).toBe("ongoing");
    expect(formatCountdown(T0, elevationPass(-2 * HOUR, -1 * HOUR))).toBe("ended");
  });

  test("two units at most, coarsening as the pass gets further away", () => {
    expect(formatCountdown(T0, elevationPass(42 * 1000, 10 * MIN))).toBe("42 s");
    expect(formatCountdown(T0, elevationPass(3 * MIN + 7 * 1000, 10 * MIN))).toBe("3 m 7 s");
    expect(formatCountdown(T0, elevationPass(3 * HOUR + 27 * MIN, 4 * HOUR))).toBe("3 h 27 m");
    expect(formatCountdown(T0, elevationPass(1 * DAY + 2 * HOUR + 3 * MIN, 2 * DAY))).toBe("1 d 2 h");
  });

  test("seconds drop out past the first minute, so a distant countdown mostly stops ticking", () => {
    // Off the minute boundary, where a second either side does change the text.
    const pass = elevationPass(3 * HOUR + 30 * 1000, 4 * HOUR);
    expect(formatCountdown(T0, pass)).toBe("3 h 0 m");
    expect(formatCountdown(T0 + 1000, pass)).toBe("3 h 0 m");
    expect(formatCountdown(T0 + 31 * 1000, pass)).toBe("2 h 59 m");
  });
});

describe("passMinutes and passSummary", () => {
  test("duration is milliseconds, and reads out as whole minutes", () => {
    expect(passMinutes(elevationPass(0, 8 * MIN + 20 * 1000))).toBe(8);
  });

  test("elevation mode quotes the window, the length and the apex as a compass point", () => {
    // The fixture's azimuthApex is 123.456, which is ESE.
    const summary = passSummary(elevationPass(1 * HOUR, 1 * HOUR + 10 * MIN));
    expect(summary).toBe("13:00–13:10 UTC · 10 min · 57° max, apex ESE");
  });

  test("swath mode quotes the offset and the footprint instead", () => {
    expect(passSummary(swathPass(1 * HOUR, 1 * HOUR + 10 * MIN))).toContain("off track");
    expect(passSummary(swathPass(1 * HOUR, 1 * HOUR + 10 * MIN))).toContain("swath");
  });
});

describe("passQuality", () => {
  test("elevation mode is the max elevation over 90 degrees", () => {
    // The fixture's maxElevation is 56.7.
    expect(passQuality(elevationPass(0, 10 * MIN))).toBeCloseTo(56.7 / 90, 5);
  });

  test("swath mode is how close to the footprint centre the station falls", () => {
    // Clamped either way, so a station outside the footprint cannot go negative.
    expect(passQuality(swathPass(0, 10 * MIN))).toBeGreaterThanOrEqual(0);
    expect(passQuality(swathPass(0, 10 * MIN))).toBeLessThanOrEqual(1);
  });
});

describe("toPassRows", () => {
  test("elevation mode uses maxElevation/azimuthApex and the given name field", () => {
    const [row] = toPassRows([elevationPass(1 * HOUR, 1 * HOUR + 10 * MIN)], NOW, "groundStationName", "elevation");
    expect(row!.name).toBe("Munich");
    expect(row!.primary).toBe("57°");
    expect(row!.secondary).toBe("123.46°");
    expect(row!.startLabel).toBe("01.07 13:00:00");
    expect(row!.endLabel).toBe("13:10:00");
    expect(row!.startMs).toBe(T0 + 1 * HOUR);
  });

  test("swath mode uses minDistance/swathWidth", () => {
    const [row] = toPassRows([swathPass(1 * HOUR, 1 * HOUR + 10 * MIN)], NOW, "name", "swath");
    expect(row!.name).toBe("ISS");
    expect(row!.primary).toBe("12.3km");
    expect(row!.secondary).toBe("1235km");
  });

  test("elevation pass in swath mode falls back to elevation columns", () => {
    const [row] = toPassRows([elevationPass(1 * HOUR, 2 * HOUR)], NOW, "name", "swath");
    expect(row!.primary).toBe("57°");
    expect(row!.secondary).toBe("123.46°");
  });
});
