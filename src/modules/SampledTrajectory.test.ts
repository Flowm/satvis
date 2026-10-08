import { Cartesian3, Math as CesiumMath, JulianDate, Matrix3, ReferenceFrame, Transforms } from "@cesium/engine";
import dayjs from "dayjs";
import { propagate } from "satellite.js";
import { beforeEach, describe, expect, test, vi } from "vitest";

import Orbit from "./Orbit";
import { SampledTrajectory } from "./SampledTrajectory";
import { drawablePositions } from "./util/drawablePositions";
import { createSatrec, parseGpPayload, type GpRecord } from "./util/gp";
import { InlineSampleSource, type SampleChunk, type TrajectorySampler } from "./util/sampleSource";

const TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

/** Time near the TLE epoch so SGP4 propagation stays meaningful. */
const T0 = JulianDate.fromDate(dayjs("2018-12-08").toDate());

const issRecord = (): GpRecord => parseGpPayload(TLE)[0] as GpRecord;

/** Samples inline, through the same code the worker runs. */
function issTrajectory(): { orbit: Orbit; trajectory: SampledTrajectory; sampler: TrajectorySampler; source: InlineSampleSource; periodSeconds: number } {
  const record = issRecord();
  const orbit = new Orbit("ISS", record);
  const source = new InlineSampleSource();
  const sampler = source.samplerFor("25544", record);
  return { orbit, trajectory: new SampledTrajectory(orbit, sampler), sampler, source, periodSeconds: orbit.orbitalPeriod * 60 };
}

/** `follow` only needs a clock and a tick event off the viewer. */
const fakeViewer = () => ({ clock: { currentTime: T0, onTick: { addEventListener: () => () => {} } } }) as unknown as Parameters<SampledTrajectory["follow"]>[0];

beforeEach(() => {
  // The ICRF transform needs async-loaded IAU data that Node lacks.
  vi.spyOn(Transforms, "computeFixedToIcrfMatrix").mockImplementation(() => Matrix3.clone(Matrix3.IDENTITY));
});

/** 3° a vertex at 120 samples an orbit; the drift ramp keeps the largest at 3.005°. */
const MAX_BEND = CesiumMath.toRadians(3.1);

/** With the identity, a period's drift is the Earth's turn, not J2's: TEME stands in for ICRF. */
function useRealEarthRotation(): void {
  vi.spyOn(Transforms, "computeFixedToIcrfMatrix").mockImplementation((time) => Matrix3.transpose(Transforms.computeTemeToPseudoFixedMatrix(time), new Matrix3()));
}

/** Radians, over every vertex of a closed loop, the seam included. */
function largestBend(loop: Cartesian3[]): number {
  const bend = (a: Cartesian3, b: Cartesian3, c: Cartesian3) => Cartesian3.angleBetween(Cartesian3.subtract(b, a, new Cartesian3()), Cartesian3.subtract(c, b, new Cartesian3()));
  const bends = loop.slice(1, -1).map((position, index) => bend(loop[index]!, position, loop[index + 2]!));
  return Math.max(...bends, bend(loop.at(-2)!, loop[0]!, loop[1]!));
}

/** Metres from `point` to the segment from `a` to `b`. */
function distanceToSegment(point: Cartesian3, a: Cartesian3, b: Cartesian3): number {
  const ab = Cartesian3.subtract(b, a, new Cartesian3());
  const along = CesiumMath.clamp(Cartesian3.dot(Cartesian3.subtract(point, a, new Cartesian3()), ab) / Cartesian3.magnitudeSquared(ab), 0, 1);
  return Cartesian3.distance(point, Cartesian3.add(a, Cartesian3.multiplyByScalar(ab, along, ab), ab));
}

describe("SampledTrajectory", () => {
  test("is empty before the first update", async () => {
    const { trajectory } = issTrajectory();
    expect(trajectory.valid).toBe(false);
    expect(trajectory.fixed).toBeUndefined();
    expect(trajectory.interval).toBeUndefined();
    expect(trajectory.position(T0)).toBeUndefined();
    expect(trajectory.positionsForNextOrbit(T0)).toHaveLength(0);
  });

  test("update covers half an orbit back and 1.5 orbits forward", async () => {
    const { trajectory, periodSeconds } = issTrajectory();
    await trajectory.ensure(T0);

    expect(trajectory.valid).toBe(true);
    const interval = trajectory.interval!;
    expect(JulianDate.secondsDifference(T0, interval.start)).toBeCloseTo(periodSeconds / 2, 5);
    expect(JulianDate.secondsDifference(interval.stop, T0)).toBeCloseTo(periodSeconds * 1.5, 5);

    const position = trajectory.position(T0);
    expect(position).toBeDefined();
    expect(Cartesian3.magnitude(position!) / 1000).toBeGreaterThan(6600);
    expect(Cartesian3.magnitude(position!) / 1000).toBeLessThan(6900);
  });

  test("window slides forward as time advances", async () => {
    const { trajectory, periodSeconds } = issTrajectory();
    await trajectory.ensure(T0);

    const later = JulianDate.addSeconds(T0, periodSeconds, new JulianDate());
    await trajectory.ensure(later);

    const interval = trajectory.interval!;
    expect(JulianDate.secondsDifference(later, interval.start)).toBeCloseTo(periodSeconds / 2, 5);
    expect(JulianDate.secondsDifference(interval.stop, later)).toBeCloseTo(periodSeconds * 1.5, 5);
    expect(trajectory.position(later)).toBeDefined();
  });

  test("positionsForNextOrbit returns one orbit closed into a loop", async () => {
    const { trajectory } = issTrajectory();
    await trajectory.ensure(T0);

    const positions = trajectory.positionsForNextOrbit(T0);
    // ~120 samples per orbit, the head, and the head again closing the loop.
    expect(positions.length).toBeGreaterThan(100);
    expect(positions.at(-1)).toBe(positions[0]);
  });

  test("groundTrack samples positions around the given time", async () => {
    const { trajectory } = issTrajectory();
    await trajectory.ensure(T0);

    const track = trajectory.groundTrack(T0, 2, 1);
    expect(track).toHaveLength(4);
    expect(track.every((position) => position !== undefined)).toBe(true);
  });

  // Callers see this from the position count alone; a degenerate pair stopped Cesium's
  // render loop (see `drawablePositions`).
  test("a clock far outside the window yields no drawable track", async () => {
    const { trajectory, periodSeconds } = issTrajectory();
    await trajectory.ensure(T0);

    const far = JulianDate.addSeconds(T0, periodSeconds * 100, new JulianDate());

    expect(trajectory.positionsForTrack(far).length).toBeLessThan(2);
    // What the ground track's corridor is built from, via #groundTrackPositions.
    expect(drawablePositions(trajectory.groundTrack(far)).length).toBeLessThan(2);
  });

  test("the inertial frame is not sampled until something asks for it", async () => {
    const { trajectory } = issTrajectory();
    await trajectory.ensure(T0);

    expect(trajectory.entityPosition).toBeDefined();
    expect(trajectory.sampleCount).toBeGreaterThan(0);
    expect(trajectory.fixed).toBeUndefined();
    expect(trajectory.inertial).toBeUndefined();
  });

  test("requireInertial backfills the window already sampled", async () => {
    const { trajectory } = issTrajectory();
    await trajectory.ensure(T0);
    const samples = trajectory.sampleCount;
    expect(samples).toBeGreaterThan(0);

    trajectory.requireInertial();

    expect(trajectory.inertial?.length()).toBe(samples);
  });

  test("requireInertial before the first update samples both frames from the start", async () => {
    const { trajectory } = issTrajectory();
    trajectory.requireInertial();
    await trajectory.ensure(T0);

    expect(trajectory.inertial?.length()).toBe(trajectory.sampleCount);
  });

  test("requireInertial is idempotent and keeps the same property instance", async () => {
    const { trajectory } = issTrajectory();
    await trajectory.ensure(T0);
    trajectory.requireInertial();
    const first = trajectory.inertial;

    trajectory.requireInertial();

    // Entities bind to this object.
    expect(trajectory.inertial).toBe(first);
  });

  test("the inertial window keeps sliding once required", async () => {
    const { trajectory, periodSeconds } = issTrajectory();
    await trajectory.ensure(T0);
    trajectory.requireInertial();

    await trajectory.ensure(JulianDate.addSeconds(T0, periodSeconds, new JulianDate()));

    expect(trajectory.inertial?.length()).toBe(trajectory.sampleCount);
  });

  test("positionsForNextOrbit starts and closes the loop at the satellite, not at the next stored sample", async () => {
    const { trajectory } = issTrajectory();
    await trajectory.ensure(T0);
    trajectory.requireInertial();

    // Across one sampling interval, so most starts fall between two stored samples.
    for (let offset = 0; offset < 50; offset += 7) {
      const start = JulianDate.addSeconds(T0, offset, new JulianDate());
      const positions = trajectory.positionsForNextOrbit(start);
      const satellite = trajectory.inertial!.getValueInReferenceFrame(start, ReferenceFrame.INERTIAL)!;

      expect(Cartesian3.distance(positions[0]!, satellite)).toBeLessThan(1);
      expect(positions.at(-1)).toBe(positions[0]);
    }
  });

  test("positionsForNextOrbit closes the loop without a bend at the satellite", async () => {
    useRealEarthRotation();
    const { trajectory } = issTrajectory();
    await trajectory.ensure(T0);

    // A start just past a sample made the closing segment short and sideways: a 95° bend.
    for (let offset = 1; offset < 50; offset += 7) {
      const positions = trajectory.positionsForNextOrbit(JulianDate.addSeconds(T0, offset, new JulianDate()));

      expect(largestBend(positions)).toBeLessThan(MAX_BEND);
      expect(positions.at(-1)).toBe(positions[0]);
    }
  });

  test("positionsForNextOrbit closes the loop without a bend when the period ends past the last sample", async () => {
    useRealEarthRotation();
    const { trajectory, periodSeconds } = issTrajectory();
    await trajectory.ensure(T0);
    trajectory.requireInertial();
    const last = trajectory.inertial!.lastTime()!;

    // The grid's last sample sits up to a step short of the window, where interpolation holds it.
    const start = JulianDate.addSeconds(last, 1 - periodSeconds, new JulianDate());

    expect(largestBend(trajectory.positionsForNextOrbit(start))).toBeLessThan(MAX_BEND);
  });

  test("positionsForNextOrbit runs through the satellite until the drift ramp", async () => {
    useRealEarthRotation();
    const { trajectory, periodSeconds } = issTrajectory();
    await trajectory.ensure(T0);
    const positions = trajectory.positionsForNextOrbit(JulianDate.addSeconds(T0, 20, new JulianDate()));

    // Up to the ramp, three quarters on, a rebuild running late still finds the satellite on its line.
    for (let fraction = 0; fraction <= 0.74; fraction += 0.01) {
      const time = JulianDate.addSeconds(T0, 20 + fraction * periodSeconds, new JulianDate());
      const satellite = trajectory.inertial!.getValueInReferenceFrame(time, ReferenceFrame.INERTIAL)!;
      const gap = Math.min(...positions.slice(1).map((position, index) => distanceToSegment(satellite, positions[index]!, position)));

      // The chord between samples sags about 2.4 km below the orbit.
      expect(gap).toBeLessThan(3000);
    }
  });

  test("positionsForNextOrbit asking for the inertial frame requires it implicitly", async () => {
    const { trajectory } = issTrajectory();
    await trajectory.ensure(T0);
    expect(trajectory.inertial).toBeUndefined();

    expect(trajectory.positionsForNextOrbit(T0).length).toBeGreaterThan(0);
    expect(trajectory.inertial).toBeDefined();
  });

  describe("sampling through a source", () => {
    test("propagates nowhere on this thread — every sample comes from the source", async () => {
      const { orbit, trajectory, source } = issTrajectory();
      const sgp4 = vi.spyOn(orbit, "positionECI");

      await trajectory.ensure(T0);

      expect(sgp4).not.toHaveBeenCalled();
      expect(source.stats.chunks).toBe(1);
      expect(source.stats.samples).toBeGreaterThan(200);
    });

    test("a slid window asks only for what it is missing", async () => {
      const { trajectory, source, periodSeconds } = issTrajectory();
      await trajectory.ensure(T0);
      const openingSamples = source.stats.samples;

      await trajectory.ensure(JulianDate.addSeconds(T0, periodSeconds / 4, new JulianDate()));

      const added = source.stats.samples - openingSamples;
      expect(added).toBeGreaterThan(0);
      expect(added).toBeLessThan(openingSamples / 2);
    });

    test("samples from consecutive requests land on one evenly spaced grid", async () => {
      const { trajectory, periodSeconds } = issTrajectory();
      await trajectory.ensure(T0);
      await trajectory.ensure(JulianDate.addSeconds(T0, periodSeconds / 4, new JulianDate()));

      trajectory.requireSampled();
      const { times } = trajectory.fixed!.getRawSamples();
      expect(times.length).toBeGreaterThan(200);
      const gaps = times.slice(1).map((time, index) => JulianDate.secondsDifference(time, times[index] as JulianDate));
      const expected = periodSeconds / 120;
      // The grid is anchored to the epoch, so the seam between chunks shows no odd gap.
      for (const gap of gaps) {
        expect(gap).toBeCloseTo(expected, 3);
      }
    });

    test("the grid entities read from agrees with the sampled property", async () => {
      const { trajectory, periodSeconds } = issTrajectory();
      await trajectory.ensure(T0);
      await trajectory.ensure(JulianDate.addSeconds(T0, periodSeconds / 4, new JulianDate()));

      // A four-point cubic against Cesium's six-point quintic. An index bug would be
      // a whole sample step (tens of kilometres) out.
      trajectory.requireSampled();
      expect(trajectory.entityPosition).not.toBe(trajectory.fixed);
      for (let offset = 0; offset < periodSeconds; offset += periodSeconds / 40) {
        const time = JulianDate.addSeconds(T0, periodSeconds / 4 + offset, new JulianDate());
        const grid = trajectory.entityPosition!.getValue(time) as Cartesian3;
        const sampled = trajectory.fixed!.getValue(time) as Cartesian3;
        expect(Cartesian3.distance(grid, sampled)).toBeLessThan(50);
      }
    });

    test("requireSampled backfills the window already held, without re-propagating", async () => {
      const { orbit, trajectory, source } = issTrajectory();
      await trajectory.ensure(T0);
      const requests = source.stats.requests;
      const sgp4 = vi.spyOn(orbit, "positionECI");

      trajectory.requireSampled();

      expect(trajectory.fixed?.length()).toBe(trajectory.sampleCount);
      expect(source.stats.requests).toBe(requests);
      expect(sgp4).not.toHaveBeenCalled();
    });

    test("requireSampled keeps the window sliding once asked for", async () => {
      const { trajectory, periodSeconds } = issTrajectory();
      await trajectory.ensure(T0);
      trajectory.requireSampled();
      const property = trajectory.fixed;

      await trajectory.ensure(JulianDate.addSeconds(T0, periodSeconds, new JulianDate()));

      // A path graphic binds to this object.
      expect(trajectory.fixed).toBe(property);
      expect(trajectory.fixed?.length()).toBe(trajectory.sampleCount);
      expect(trajectory.fixed?.getValue(JulianDate.addSeconds(T0, periodSeconds, new JulianDate()))).toBeDefined();
    });

    test("a trajectory re-initialised after asking still gets the sampled property", async () => {
      const { trajectory, periodSeconds } = issTrajectory();
      await trajectory.ensure(T0);
      trajectory.requireSampled();

      // A clock jump clear of the window re-inits.
      await trajectory.ensure(JulianDate.addSeconds(T0, periodSeconds * 50, new JulianDate()));

      expect(trajectory.fixed?.length()).toBe(trajectory.sampleCount);
    });

    test("a gap in a chunk falls back to the sampled property rather than closing it", async () => {
      const { trajectory, sampler } = issTrajectory();
      vi.spyOn(sampler, "samples").mockImplementation(async (from, to) => {
        const chunk = (await new InlineSampleSource().samplerFor("25544", issRecord()).samples(from, to)) as SampleChunk;
        return { ...chunk, refusedIndices: [5, 6, 7] };
      });

      await trajectory.ensure(T0);

      expect(trajectory.fixed).toBeDefined();
      expect(trajectory.entityPosition).toBe(trajectory.fixed);
      expect(trajectory.sampleCount).toBeGreaterThan(0);
      expect(trajectory.position(T0)).toBeDefined();
    });

    test("an abandoned grid does not go on answering with the window it stopped at", async () => {
      const { periodSeconds } = issTrajectory();
      const inline = new InlineSampleSource().samplerFor("25544", issRecord());
      let gap = false;
      const sampler: TrajectorySampler = {
        samples: async (from, to) => {
          const chunk = (await inline.samples(from, to)) as SampleChunk;
          return gap ? { ...chunk, refusedIndices: [2] } : chunk;
        },
      };
      const subject = new SampledTrajectory(new Orbit("ISS", issRecord()), sampler);

      await subject.ensure(T0);
      // Captured from the grid before the gap; afterwards both readers share one store.
      const gridCount = subject.sampleCount;
      // Not T0: the new window starts there, and a first-sample read HOLDs (~350 km off).
      const probe = JulianDate.addSeconds(T0, periodSeconds / 4, new JulianDate());
      const atProbe = subject.position(probe)!;
      expect(gridCount).toBeGreaterThan(200);

      gap = true;
      const later = JulianDate.addSeconds(T0, periodSeconds / 2, new JulianDate());
      await subject.ensure(later);

      expect(subject.entityPosition).toBe(subject.fixed);
      // Eviction trims the far end, so the count lands near the pre-gap one.
      expect(subject.sampleCount).toBeGreaterThan(gridCount / 2);
      // If the backfill came up empty, `fixed` would hold only the gapped chunk and
      // HOLD would answer this with a sample 1.25 revolutions away.
      expect(Cartesian3.distance(subject.position(probe)!, atProbe)).toBeLessThan(50);
      expect(subject.position(later)).toBeDefined();
      expect(subject.positionsForTrack(later).length).toBeGreaterThan(1);
    });

    test("refused samples are skipped rather than re-propagated", async () => {
      const { orbit, trajectory, sampler } = issTrajectory();
      const sgp4 = vi.spyOn(orbit, "positionECI");
      vi.spyOn(sampler, "samples").mockImplementation(async (from, to) => {
        const chunk = (await new InlineSampleSource().samplerFor("25544", issRecord()).samples(from, to)) as SampleChunk;
        return { ...chunk, refusedIndices: [5, 6, 7] };
      });

      await trajectory.ensure(T0);

      expect(sgp4).not.toHaveBeenCalled();
      expect(trajectory.valid).toBe(true);
      expect(trajectory.position(T0)).toBeDefined();
    });

    test("a source that cannot answer leaves the trajectory empty rather than wrong", async () => {
      const { trajectory, sampler } = issTrajectory();
      vi.spyOn(sampler, "samples").mockResolvedValue(undefined);

      await trajectory.ensure(T0);

      expect(trajectory.valid).toBe(false);
      expect(trajectory.position(T0)).toBeUndefined();
    });

    test("only one request is outstanding, however many ticks arrive", async () => {
      const { trajectory, sampler, periodSeconds } = issTrajectory();
      await trajectory.ensure(T0);

      let outstanding = 0;
      let peak = 0;
      const inline = new InlineSampleSource().samplerFor("25544", issRecord());
      vi.spyOn(sampler, "samples").mockImplementation(async (from, to) => {
        outstanding += 1;
        peak = Math.max(peak, outstanding);
        await Promise.resolve();
        outstanding -= 1;
        return inline.samples(from, to);
      });

      const later = (n: number) => JulianDate.addSeconds(T0, (periodSeconds / 4) * n, new JulianDate());
      await Promise.all([trajectory.ensure(later(1)), trajectory.ensure(later(2)), trajectory.ensure(later(3)), trajectory.ensure(later(4))]);

      expect(peak).toBe(1);
    });

    test("a tick coalesced away is honoured once the fill lands", async () => {
      const { trajectory, sampler, periodSeconds } = issTrajectory();
      await trajectory.ensure(T0);
      const asked: Array<[number, number]> = [];
      const inline = new InlineSampleSource().samplerFor("25544", issRecord());
      vi.spyOn(sampler, "samples").mockImplementation(async (from, to) => {
        asked.push([from, to]);
        return inline.samples(from, to);
      });

      const first = trajectory.ensure(JulianDate.addSeconds(T0, periodSeconds / 4, new JulianDate()));
      const jumped = JulianDate.addSeconds(T0, periodSeconds * 4, new JulianDate());
      const second = trajectory.ensure(jumped);
      await Promise.all([first, second]);
      // The re-run is scheduled from a `finally`, so let it settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(asked.length).toBeGreaterThan(1);
      expect(trajectory.position(jumped)).toBeDefined();
    });

    test("follow only arranges the top-ups; it does not fill", async () => {
      const { trajectory, source } = issTrajectory();
      let notified = 0;

      trajectory.follow(fakeViewer(), () => {
        notified += 1;
      });

      expect(notified).toBe(0);
      expect(source.stats.requests).toBe(0);
      trajectory.stop();
    });

    test("a stopped trajectory stays empty, even when a fill lands after", async () => {
      const { trajectory } = issTrajectory();
      const filling = trajectory.ensure(T0);

      trajectory.stop();
      await filling;
      await trajectory.ensure(T0);

      expect(trajectory.position(T0)).toBeUndefined();
    });
  });

  describe("fixed-frame samples", () => {
    // End to end from the element set, independent of the chunk, so a sign flip or a
    // wrong instant cannot pass by agreeing with itself (temeToFixed.test.ts pins the angle).
    test("are Cesium's own rotation of an independently propagated TEME", async () => {
      const { trajectory, sampler } = issTrajectory();
      const startMs = JulianDate.toDate(T0).getTime();
      const chunk = (await sampler.samples(startMs, startMs + 30 * 60_000)) as SampleChunk;
      expect(chunk).toBeDefined();
      const samples = Math.floor(chunk.positionsFixed.length / 3);
      expect(samples).toBeGreaterThan(10);

      trajectory.adopt(chunk);

      const satrec = createSatrec(issRecord());
      const { anchorEpochMs, firstIndex, startEpochMs, stepSeconds } = chunk;
      const stepMs = stepSeconds * 1000;
      // Truncated as the sampler truncates: the grid files sample zero here.
      const anchor = JulianDate.fromDate(new Date(anchorEpochMs));
      let worst = 0;
      for (let index = 0; index < samples; index += 1) {
        const propagated = propagate(satrec, new Date(startEpochMs + index * stepMs));
        const teme = propagated?.position;
        expect(teme).toBeTruthy();
        const temeMetres = new Cartesian3((teme as { x: number }).x * 1000, (teme as { y: number }).y * 1000, (teme as { z: number }).z * 1000);
        const time = JulianDate.addSeconds(anchor, (firstIndex + index) * stepSeconds, new JulianDate());
        const expected = Matrix3.multiplyByVector(Transforms.computeTemeToPseudoFixedMatrix(time, new Matrix3()), temeMetres, new Cartesian3());
        const actual = trajectory.position(time);
        expect(actual).toBeDefined();
        worst = Math.max(worst, Cartesian3.distance(expected, actual as Cartesian3));
      }
      // Millimetres; a wrong rotation is kilometres out.
      expect(worst).toBeLessThan(1e-3);
    });
  });
});
