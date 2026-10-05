import { afterEach, describe, expect, test, vi } from "vitest";

import { parseGpPayload, type GpRecord } from "./gp";
import { laneIndexFor, WorkerSampleSource } from "./sampleSource";
import type { Sgp4Request } from "./sgp4Worker";

describe("laneIndexFor", () => {
  test("sends a satnum to the same lane every time", () => {
    for (const satnum of ["25544", "00900", "62841", "1", "999999"]) {
      const first = laneIndexFor(satnum, 4);
      for (let repeat = 0; repeat < 100; repeat += 1) {
        expect(laneIndexFor(satnum, 4)).toBe(first);
      }
    }
  });

  test("stays inside the pool", () => {
    for (let laneCount = 1; laneCount <= 8; laneCount += 1) {
      for (let satnum = 0; satnum < 500; satnum += 1) {
        const lane = laneIndexFor(String(satnum), laneCount);
        expect(lane).toBeGreaterThanOrEqual(0);
        expect(lane).toBeLessThan(laneCount);
        expect(Number.isInteger(lane)).toBe(true);
      }
    }
  });

  test("collapses to the single lane", () => {
    expect(laneIndexFor("25544", 1)).toBe(0);
    expect(laneIndexFor("25544", 0)).toBe(0);
  });

  test("spreads consecutive catalog numbers across the pool", () => {
    // Satellites arrive as a slice of the sorted catalog, so satnums are consecutive.
    const laneCount = 4;
    const counts: number[] = Array.from({ length: laneCount }, () => 0);
    const population = 5000;
    for (let satnum = 20_000; satnum < 20_000 + population; satnum += 1) {
      const lane = laneIndexFor(String(satnum), laneCount);
      counts[lane] = (counts[lane] ?? 0) + 1;
    }
    const expected = population / laneCount;
    for (const count of counts) {
      // Within 20% of even: this asserts "not degenerate", not a property of FNV-1a.
      expect(count).toBeGreaterThan(expected * 0.8);
      expect(count).toBeLessThan(expected * 1.2);
    }
  });

  test("spreads non-numeric satnums too", () => {
    const laneCount = 4;
    const seen = new Set<number>();
    for (const satnum of ["ISS", "STARLINK-1007", "2019-074A", "COSMOS 2251 DEB", "T-1", "unknown"]) {
      seen.add(laneIndexFor(satnum, laneCount));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

const TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";
const issRecord = (): GpRecord => parseGpPayload(TLE)[0] as GpRecord;
const T0 = Date.UTC(2018, 11, 8);

class FakeWorker {
  static instances: FakeWorker[] = [];

  posted: Sgp4Request[] = [];

  terminated = false;

  #listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), handler]);
  }

  postMessage(request: Sgp4Request): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.#listeners.get(type) ?? []) handler(event);
  }
}

/** Six cores, so `hardwareConcurrency - 2` is four. */
function poolOfFour(): { source: WorkerSampleSource; errors: ReturnType<typeof vi.spyOn> } {
  FakeWorker.instances = [];
  vi.stubGlobal("navigator", { hardwareConcurrency: 6 });
  vi.stubGlobal("Worker", FakeWorker);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  return { source: new WorkerSampleSource(), errors };
}

const ask = (source: WorkerSampleSource, satnum: string) => source.samplerFor(satnum, issRecord()).samples(T0 - 2_700_000, T0 + 2_700_000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorkerSampleSource pool", () => {
  test("spawns one worker per lane and routes a satnum to the same one every time", async () => {
    const { source } = poolOfFour();
    expect(FakeWorker.instances).toHaveLength(4);

    void ask(source, "25544");
    void ask(source, "25544");
    await Promise.resolve();

    const carrying = FakeWorker.instances.filter((worker) => worker.posted.length > 0);
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.posted.flatMap((request) => request.commands)).toHaveLength(2);
  });

  test("a single worker failing answers every outstanding request inline", async () => {
    const { source, errors } = poolOfFour();
    // Some flushed and some still queued, so both the in-flight map and the queue are non-empty.
    const flushed = ["25544", "00900", "43013", "62841"].map((satnum) => ask(source, satnum));
    await Promise.resolve();
    const queued = ["11111", "22222"].map((satnum) => ask(source, satnum));

    FakeWorker.instances[0]?.emit("error", { message: "boom" });

    const chunks = await Promise.all([...flushed, ...queued]);
    // Answered with real samples, not merely settled.
    expect(chunks).toHaveLength(6);
    for (const chunk of chunks) {
      expect(chunk?.positionsFixed.length).toBeGreaterThan(0);
    }
    expect(source.stats.inlineFallbacks).toBe(6);
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  test("requests made after the pool is given up on never reach a worker", async () => {
    const { source } = poolOfFour();
    FakeWorker.instances[0]?.emit("error", { message: "boom" });

    const chunk = await ask(source, "25544");

    expect(chunk?.positionsFixed.length).toBeGreaterThan(0);
    expect(FakeWorker.instances.every((worker) => worker.posted.length === 0)).toBe(true);
    expect(source.stats.inlineFallbacks).toBe(1);
  });

  test("a lane that goes silent while holding work gives up too", async () => {
    vi.useFakeTimers();
    try {
      const { source, errors } = poolOfFour();
      const pending = ask(source, "25544");
      await Promise.resolve();

      vi.advanceTimersByTime(4000);

      expect(await pending).toBeDefined();
      expect(errors).toHaveBeenCalledTimes(1);
      expect(source.stats.inlineFallbacks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an idle lane is not mistaken for a dead one", async () => {
    vi.useFakeTimers();
    try {
      const { source, errors } = poolOfFour();
      // One lane answers; the other three hold no work.
      void ask(source, "25544");
      await Promise.resolve();
      const busy = FakeWorker.instances.find((worker) => worker.posted.length > 0);
      const batchId = busy?.posted[0]?.batchId as number;
      busy?.emit("message", { data: { batchId, replies: [{ kind: "unopenable", satnum: "25544", reason: "test" }] } });

      vi.advanceTimersByTime(60_000);

      expect(errors).not.toHaveBeenCalled();
      expect(FakeWorker.instances.some((worker) => worker.terminated)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
