import { Cartesian3, JulianDate, TimeInterval } from "@cesium/core";
import { describe, expect, test } from "vitest";

import { GroundTrack, LEAD_SECONDS, reachSeconds } from "./GroundTrackBatch";
import { TRACK_SECONDS_ATTRIBUTE } from "./groundTrackRibbon";

const T0 = JulianDate.fromIso8601("2026-01-01T00:00:00Z");

const at = (seconds: number): JulianDate => JulianDate.addSeconds(T0, seconds, new JulianDate());

/** A satellite flying north along the prime meridian, a sample every 60 s from `from` to `to`. */
function trajectory(from: number, to: number): ConstructorParameters<typeof GroundTrack>[0] {
  return {
    interval: new TimeInterval({ start: at(from), stop: at(to) }),
    samplesBetween: (start, stop) => {
      const times: JulianDate[] = [];
      const positions: Cartesian3[] = [];
      for (let second = from; second <= to; second += 60) {
        if (JulianDate.lessThan(at(second), start) || JulianDate.greaterThan(at(second), stop)) {
          continue;
        }
        times.push(at(second));
        positions.push(Cartesian3.fromDegrees(0, second / 240, 400_000));
      }
      return { times, positions };
    },
  };
}

const SWATH = { starboardMeters: 50_000, portMeters: 50_000 };

/** The vertex times of a cut. */
function vertexSeconds(track: GroundTrack, epoch: JulianDate, reach: number): number[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Array.from((track.cut(epoch, reach)!.geometry.attributes as any)[TRACK_SECONDS_ATTRIBUTE].values as Float32Array);
}

describe("GroundTrack", () => {
  test("counts its vertex times from the epoch, over the reach either side of the lead", () => {
    const track = new GroundTrack(trajectory(-3600, 3600), SWATH, () => "ISS");
    // On the 60 s grid, so the reach ends on samples.
    const times = vertexSeconds(track, at(960), 600);
    expect(Math.min(...times)).toBe(-600);
    expect(Math.max(...times)).toBe(LEAD_SECONDS + 600);
    expect(track.coversReach).toBe(true);
  });

  test("does not cover its reach near the end of the samples, so a refill cuts it again", () => {
    const track = new GroundTrack(trajectory(-3600, 1200), SWATH, () => "ISS");
    expect(Math.max(...vertexSeconds(track, at(600), 600))).toBe(600);
    expect(track.coversReach).toBe(false);
  });

  test("cuts nothing outside the samples", () => {
    const track = new GroundTrack(trajectory(-3600, 3600), SWATH, () => "ISS");
    expect(track.cut(at(86_400), 600)).toBeUndefined();
    expect(track.coversReach).toBe(false);
  });

  test("is picked as what its satellite selects at the time of the cut", () => {
    let selects: unknown = "ISS";
    const track = new GroundTrack(trajectory(-3600, 3600), SWATH, () => selects);
    expect(track.cut(T0, 600)!.id).toBe("ISS");
    selects = { name: "ISS" };
    expect(track.cut(T0, 600)!.id).toBe(selects);
  });
});

describe("reachSeconds", () => {
  test("is 600 s at rest and up to x300, and grows with the clock to the window's 1,200 s", () => {
    expect(reachSeconds(0)).toBe(600);
    expect(reachSeconds(300)).toBe(600);
    expect(reachSeconds(450)).toBe(900);
    expect(reachSeconds(48_000)).toBe(1200);
  });
});
