import { Cartesian3, JulianDate, Matrix3, ReferenceFrame, Transforms } from "@cesium/engine";
import dayjs from "dayjs";
import { propagate } from "satellite.js";
import { beforeEach, describe, expect, test, vi } from "vitest";

import Orbit from "./Orbit";
import { SampledTrajectory } from "./SampledTrajectory";
import { drawablePositions } from "./util/drawablePositions";
import { createSatrec, parseGpPayload, type GpRecord } from "./util/gp";
import { InlineSampleSource, type SampleChunk, type TrajectorySampler } from "./util/sampleSource";

const TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

// Time near the TLE epoch so SGP4 propagation stays meaningful.
const T0 = JulianDate.fromDate(dayjs("2018-12-08").toDate());

const issRecord = (): GpRecord => parseGpPayload(TLE)[0] as GpRecord;

/**
 * A trajectory sampling inline. The unit tests are the second implementation's
 * reason for existing: they exercise the same code the worker runs, on this
 * thread, with no transport in the way.
 */
function issTrajectory(): { orbit: Orbit; trajectory: SampledTrajectory; sampler: TrajectorySampler; source: InlineSampleSource; periodSeconds: number } {
  const record = issRecord();
  const orbit = new Orbit("ISS", record);
  const source = new InlineSampleSource();
  const sampler = source.samplerFor("25544", record);
  return { orbit, trajectory: new SampledTrajectory(orbit, sampler), sampler, source, periodSeconds: orbit.orbitalPeriod * 60 };
}

/** `start` only needs a clock and a tick event off the viewer. */
const fakeViewer = () => ({ clock: { currentTime: T0, onTick: { addEventListener: () => () => {} } } }) as unknown as Parameters<SampledTrajectory["start"]>[0];

beforeEach(() => {
  // The ICRF transform needs async-loaded IAU data that is unavailable in
  // Node; pin it to identity — these tests cover the window bookkeeping, not
  // the frame conversion itself.
  vi.spyOn(Transforms, "computeFixedToIcrfMatrix").mockImplementation(() => Matrix3.clone(Matrix3.IDENTITY));
});

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

    // Interpolated fixed-frame position sits at a plausible LEO radius.
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

  // Outside the sampled window there is no track, and the callers have to see that
  // from the position count alone. A degenerate pair instead is what stopped
  // Cesium's render loop — see `drawablePositions` for the chain.
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

    // A scene drawing points and nothing else pays for one sample set, not three:
    // the grid, and neither irregular-capable property.
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

    // Backfilled from the samples already held rather than re-propagated, so the
    // two frames cover exactly the same instants.
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

    // Entities bind to this object, so replacing it would silently strand them.
    expect(trajectory.inertial).toBe(first);
  });

  test("the inertial window keeps sliding once required", async () => {
    const { trajectory, periodSeconds } = issTrajectory();
    await trajectory.ensure(T0);
    trajectory.requireInertial();

    await trajectory.ensure(JulianDate.addSeconds(T0, periodSeconds, new JulianDate()));

    // Not just backfilled once: the flag has to make every later refresh sample
    // both frames, or the orbit would freeze a window behind the satellite.
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

      // Orbit still owns propagation for pass prediction and the info panel, but
      // the sampling path no longer touches it.
      expect(sgp4).not.toHaveBeenCalled();
      expect(source.stats.chunks).toBe(1);
      expect(source.stats.samples).toBeGreaterThan(200);
    });

    test("a slid window asks only for what it is missing", async () => {
      const { trajectory, source, periodSeconds } = issTrajectory();
      await trajectory.ensure(T0);
      const openingSamples = source.stats.samples;

      await trajectory.ensure(JulianDate.addSeconds(T0, periodSeconds / 4, new JulianDate()));

      // A quarter revolution on is a quarter revolution of new samples, not
      // another whole window.
      const added = source.stats.samples - openingSamples;
      expect(added).toBeGreaterThan(0);
      expect(added).toBeLessThan(openingSamples / 2);
    });

    test("samples from consecutive requests land on one evenly spaced grid", async () => {
      const { trajectory, periodSeconds } = issTrajectory();
      await trajectory.ensure(T0);
      await trajectory.ensure(JulianDate.addSeconds(T0, periodSeconds / 4, new JulianDate()));

      // Through the sampled property, whose stored times are the thing under test;
      // asking for it backfills them from the grid.
      trajectory.requireSampled();
      const { times } = trajectory.fixed!.getRawSamples();
      expect(times.length).toBeGreaterThan(200);
      const gaps = times.slice(1).map((time, index) => JulianDate.secondsDifference(time, times[index] as JulianDate));
      const expected = periodSeconds / 120;
      // The grid is anchored to the element set's epoch, so the seam between two
      // chunks is indistinguishable from anywhere else in the window. Without
      // that anchor this is where a duplicated or short gap would show up.
      for (const gap of gaps) {
        expect(gap).toBeCloseTo(expected, 3);
      }
    });

    test("the grid entities read from agrees with the sampled property", async () => {
      const { trajectory, periodSeconds } = issTrajectory();
      await trajectory.ensure(T0);
      await trajectory.ensure(JulianDate.addSeconds(T0, periodSeconds / 4, new JulianDate()));

      // Not the same property, so not the same answer: a four-point cubic against
      // Cesium's six-point quintic over identical samples. The bound is what makes
      // the swap safe — a bug in the grid's index arithmetic would put the
      // satellite a whole sample step away, which is tens of kilometres.
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

      // The samples are already in hand; only the times have to be rebuilt, and
      // those come from the grid's anchor.
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

      // A path graphic binds to this object, so it has to keep being fed rather
      // than freeze at the window it was created from.
      expect(trajectory.fixed).toBe(property);
      expect(trajectory.fixed?.length()).toBe(trajectory.sampleCount);
      expect(trajectory.fixed?.getValue(JulianDate.addSeconds(T0, periodSeconds, new JulianDate()))).toBeDefined();
    });

    test("a trajectory re-initialised after asking still gets the sampled property", async () => {
      const { trajectory, periodSeconds } = issTrajectory();
      await trajectory.ensure(T0);
      trajectory.requireSampled();

      // A clock jump clear of the window re-inits, which must honour what the
      // trajectory was already committed to sampling.
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

      // The grid read assumes no holes, so a chunk with any abandons the grid and
      // brings the sampled property into being unasked — that is the whole point of
      // the fallback, and without it a gapped satellite would have nowhere to read.
      expect(trajectory.fixed).toBeDefined();
      expect(trajectory.entityPosition).toBe(trajectory.fixed);
      expect(trajectory.sampleCount).toBeGreaterThan(0);
      expect(trajectory.position(T0)).toBeDefined();
    });

    test("an abandoned grid does not go on answering with the window it stopped at", async () => {
      const { periodSeconds } = issTrajectory();
      const inline = new InlineSampleSource().samplerFor("25544", issRecord());
      let gap = false;
      // A gap only on the second fill, so the grid is populated and then abandoned.
      const sampler: TrajectorySampler = {
        samples: async (from, to) => {
          const chunk = (await inline.samples(from, to)) as SampleChunk;
          return gap ? { ...chunk, refusedIndices: [2] } : chunk;
        },
      };
      const subject = new SampledTrajectory(new Orbit("ISS", issRecord()), sampler);

      await subject.ensure(T0);
      // Captured from the grid, before the gap, so it is an independent value to
      // compare against rather than the same store asked twice — comparing
      // `position()` with `fixed.getValue()` after the fallback is comparing one
      // property to itself, which passes at distance 0 however broken the handover.
      const gridCount = subject.sampleCount;
      // A quarter orbit on, so it is comfortably inside the window both before and
      // after the refill. T0 itself is no good: the new window starts exactly there,
      // and a read at a window's first sample HOLDs rather than interpolates, which
      // is a legitimate ~350 km at one grid step and says nothing about the handover.
      const probe = JulianDate.addSeconds(T0, periodSeconds / 4, new JulianDate());
      const atProbe = subject.position(probe)!;
      expect(gridCount).toBeGreaterThan(200);

      gap = true;
      const later = JulianDate.addSeconds(T0, periodSeconds / 2, new JulianDate());
      await subject.ensure(later);

      // The window the grid held has to survive into the sampled property. If the
      // backfill came up empty the property would hold only the gapped chunk, and
      // HOLD would answer T0 with that chunk's first sample — most of an orbit away.
      expect(subject.entityPosition).toBe(subject.fixed);
      // A whole window, not just the gapped chunk — eviction trims the far end, so
      // the count lands near the pre-gap one rather than above it.
      expect(subject.sampleCount).toBeGreaterThan(gridCount / 2);
      // If the backfill came up empty, `fixed` would hold only the gapped chunk and
      // HOLD would answer this with a sample 1.25 revolutions away.
      expect(Cartesian3.distance(subject.position(probe)!, atProbe)).toBeLessThan(50);
      expect(subject.position(later)).toBeDefined();
      // And the raw-sample readers follow the same store, or the track would be cut
      // from a window the satellite has already left.
      expect(subject.positionsForTrack(later).length).toBeGreaterThan(1);
    });

    test("refused samples are skipped rather than re-propagated", async () => {
      const { orbit, trajectory, sampler } = issTrajectory();
      const sgp4 = vi.spyOn(orbit, "positionECI");
      vi.spyOn(sampler, "samples").mockImplementation(async (from, to) => {
        const chunk = (await new InlineSampleSource().samplerFor("25544", issRecord()).samples(from, to)) as SampleChunk;
        // Blank three samples the way the propagator would when it refuses them.
        return { ...chunk, refusedIndices: [5, 6, 7] };
      });

      await trajectory.ensure(T0);

      // Retrying would run the same propagator on the same instants and fail the
      // same way, so the samples are simply absent.
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

      // Four ticks in one turn, the way a fast clock delivers them.
      const later = (n: number) => JulianDate.addSeconds(T0, (periodSeconds / 4) * n, new JulianDate());
      await Promise.all([trajectory.ensure(later(1)), trajectory.ensure(later(2)), trajectory.ensure(later(3)), trajectory.ensure(later(4))]);

      // Without coalescing each of these computes the same missing range against
      // the same un-updated interval and asks for it again.
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
      // Arrives while the first is still out, and asks about a much later time.
      const jumped = JulianDate.addSeconds(T0, periodSeconds * 4, new JulianDate());
      const second = trajectory.ensure(jumped);
      await Promise.all([first, second]);
      // The re-run is scheduled from a `finally`, so let it settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The jump is not lost: the window ends up covering where the clock went.
      expect(asked.length).toBeGreaterThan(1);
      expect(trajectory.position(jumped)).toBeDefined();
    });

    test("start only arranges the top-ups; it does not fill", async () => {
      const { trajectory, source } = issTrajectory();
      let notified = 0;

      const teardown = trajectory.start(fakeViewer(), () => {
        notified += 1;
      });

      expect(notified).toBe(1);
      expect(source.stats.requests).toBe(0);
      teardown();
    });
  });

  describe("fixed-frame samples", () => {
    // The rotation out of TEME is the sampler's own arithmetic rather than a Cesium
    // call (see temeToFixed, sgp4Worker). temeToFixed.test.ts pins the angle against
    // Cesium; this pins the whole path end to end, from a satrec this test propagates
    // itself to what a consumer reads back — so neither a sign flip nor a chunk
    // handled at the wrong instant can pass by agreeing with itself.
    //
    // Deliberately independent of where the rotation happens: it reconstructs the
    // expected position from the element set, not from anything the chunk carries.
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
      // Truncated for the same reason the sampler truncates: this is where the grid
      // files sample zero, whatever the anchor's fractional millisecond says.
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
      // Millimetres, against positions in the millions of metres. A wrong rotation
      // is kilometres out, so this is a wide margin around an exact expectation.
      expect(worst).toBeLessThan(1e-3);
    });
  });
});
