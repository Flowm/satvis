import { Cartesian3, Event, JulianDate, Math as CesiumMath, PerspectiveFrustum } from "@cesium/core";
import { type Scene, SceneMode } from "@cesium/engine";
import { describe, expect, test, vi } from "vitest";

import { EARTH_ROTATION_RAD_S } from "./Orbit";
import type Orbit from "./Orbit";
import { DEFAULT_LIMITS, type PacedSatellite, RenderPacer, angularRate, distanceToShell, lineDistance, lineSpeed, maxPixelsPerRadian, renderTimeChange } from "./renderPacing";
import type { SampleVisitor } from "./util/GridPositionProperty";

/** Metres the line distance takes off for the drift; LINE_DRIFT_METRES. */
const DRIFT = 100_000;

/** Visits `samples`, `step` seconds apart from `start`. */
function samplesOf(samples: [number, number, number][], start = 0, step = 60) {
  return (visit: SampleVisitor) => samples.forEach(([x, y, z], index) => visit(x, y, z, start + index * step));
}

describe("angularRate", () => {
  test("is speed over distance at the nearest approach within the horizon", () => {
    expect(angularRate(20_000_000, 8_000, 0)).toBeCloseTo(4e-4);
    expect(angularRate(20_000_000, 8_000, 1_000)).toBeCloseTo(8_000 / 12_000_000);
  });

  test("is infinite for something that could reach the camera", () => {
    expect(angularRate(5_000, 8_000, 1)).toBe(Infinity);
  });
});

describe("maxPixelsPerRadian", () => {
  test("is the focal length at the centre of a square view, more towards its corners", () => {
    const focal = 500 / Math.tan(Math.PI / 6);
    // tan²θ at the corner of a 1000 × 1000 view: (√2 · 500 / f)².
    expect(maxPixelsPerRadian(1000, 1000, Math.PI / 3)).toBeCloseTo(focal * (1 + ((Math.SQRT2 * 500) / focal) ** 2));
    expect(maxPixelsPerRadian(1000, 1000, Math.PI / 3)).toBeGreaterThan(focal);
  });

  test("takes the field of view along the longer side, as Cesium does", () => {
    expect(maxPixelsPerRadian(2000, 1000, 1)).toBeCloseTo(maxPixelsPerRadian(1000, 2000, 1));
  });
});

describe("distanceToShell", () => {
  test("is the gap to the shell from outside, from inside, and zero within it", () => {
    expect(distanceToShell(25_000, 6_700, 7_100)).toBe(17_900);
    expect(distanceToShell(6_400, 6_700, 7_100)).toBe(300);
    expect(distanceToShell(6_900, 6_700, 7_100)).toBe(0);
  });
});

describe("renderTimeChange", () => {
  // The default view on an iPad mini 6: 2266 × 1218 device pixels, Cesium's 60°.
  const pixelsPerRadian = maxPixelsPerRadian(2266, 1218, Math.PI / 3);

  test("waits over a third of a second at the default view, where a LEO satellite may cross 1.3 pixels a second", () => {
    const leo = angularRate(18_000_000, 8_300, DEFAULT_LIMITS.ceiling);
    expect(leo * pixelsPerRadian).toBeCloseTo(1.29, 1);
    expect(renderTimeChange(leo, pixelsPerRadian)).toBeGreaterThan(1 / 3);
  });

  test("keeps today's 1/30 s near a satellite", () => {
    expect(renderTimeChange(angularRate(50_000, 8_000, 1), pixelsPerRadian)).toBe(DEFAULT_LIMITS.floor);
  });

  test("waits the ceiling when nothing moves, and the floor when the bound is not a number", () => {
    expect(renderTimeChange(0, pixelsPerRadian)).toBe(DEFAULT_LIMITS.ceiling);
    expect(renderTimeChange(Infinity, pixelsPerRadian)).toBe(DEFAULT_LIMITS.floor);
    expect(renderTimeChange(Number.NaN, pixelsPerRadian)).toBe(DEFAULT_LIMITS.floor);
  });
});

describe("lineDistance", () => {
  test("is the nearest sample's distance, less half the longest step and the drift", () => {
    const forEach = samplesOf([
      [10_000_000, 0, 0],
      [10_000_000, 400_000, 0],
      [10_000_000, 600_000, 0],
    ]);
    expect(lineDistance(forEach, new Cartesian3(30_000_000, 600_000, 0), false)).toBeCloseTo(20_000_000 - 200_000 - DRIFT);
  });

  test("turns each sample with the Earth for an orbit held still in inertial space", () => {
    // A quarter turn of the Earth before the time asked for, the sample sits a quarter turn back.
    const forEach = samplesOf([[10_000_000, 0, 0]], -Math.PI / 2 / EARTH_ROTATION_RAD_S);
    const camera = new Cartesian3(0, -12_000_000, 0);
    expect(lineDistance(forEach, camera, true)).toBeCloseTo(2_000_000 - DRIFT, -1);
    expect(lineDistance(forEach, camera, false)).toBeCloseTo(Math.hypot(10_000_000, 12_000_000) - DRIFT);
  });

  test("passes over samples SGP4 refused, and steps across them", () => {
    const forEach = samplesOf([
      [10_000_000, 0, 0],
      [NaN, NaN, NaN],
      [10_000_000, 9_000_000, 0],
    ]);
    expect(lineDistance(forEach, new Cartesian3(20_000_000, 0, 0), false)).toBeCloseTo(10_000_000 - DRIFT);
  });

  test("is undefined without a sample", () => {
    expect(lineDistance(samplesOf([]), new Cartesian3(20_000_000, 0, 0), false)).toBeUndefined();
    expect(lineDistance(samplesOf([[NaN, NaN, NaN]]), new Cartesian3(20_000_000, 0, 0), false)).toBeUndefined();
  });
});

describe("lineSpeed", () => {
  // Arktika-M 1's shell, metres, and the shell's bound, the perigee's speed and the Earth's turn at apogee.
  const shell = { inner: 7_036_000, outer: 46_070_000, speed: 14_600 };

  test("is the satellite's speed where it is, well under the shell's near apogee", () => {
    const apogee = lineSpeed(46_000_000, shell, false);
    expect(apogee).toBeGreaterThan(1.1 * EARTH_ROTATION_RAD_S * 46_000_000);
    expect(apogee).toBeLessThan(6_000);
    expect(lineSpeed(7_100_000, shell, false)).toBeGreaterThan(10_000);
    expect(lineSpeed(7_100_000, shell, false)).toBeLessThan(shell.speed);
  });

  test("is at least the Earth's turn at the outer radius for an orbit held in inertial space, at most the shell's", () => {
    expect(lineSpeed(46_000_000, shell, true)).toBeGreaterThanOrEqual(1.1 * EARTH_ROTATION_RAD_S * shell.outer);
    expect(lineSpeed(7_100_000, { ...shell, speed: 1_000 }, true)).toBe(1_000);
  });
});

describe("RenderPacer", () => {
  const time = JulianDate.fromIso8601("2026-10-26T00:00:00Z");

  /** The default view's camera, 26,109 km from the Earth's centre, looking at it. */
  function stubScene(cameraRadius = 26_109_000) {
    const scene = {
      requestRenderMode: true,
      mode: SceneMode.SCENE3D,
      drawingBufferWidth: 2266,
      drawingBufferHeight: 1218,
      maximumRenderTimeChange: 0,
      preUpdate: new Event(),
      camera: {
        positionWC: new Cartesian3(cameraRadius, 0, 0),
        directionWC: new Cartesian3(-1, 0, 0),
        frustum: new PerspectiveFrustum({ fov: CesiumMath.toRadians(60), aspectRatio: 2266 / 1218, near: 1, far: 1e9 }),
      },
    };
    return scene;
  }

  /** A satellite at `position`, its orbit between `perigeeKm` and `apogeeKm`, its window's samples `samples`. */
  function satellite(options: {
    position: Cartesian3;
    perigeeKm: number;
    apogeeKm: number;
    orbitalPeriod?: number;
    samples?: [number, number, number][];
    components?: string[];
  }): PacedSatellite {
    const orbit = { radiusRangeKm: [options.perigeeKm, options.apogeeKm], maxFixedSpeedKmS: 10, orbitalPeriod: options.orbitalPeriod ?? 100 } as unknown as Orbit;
    return {
      props: {
        orbit,
        trajectory: {
          entityPosition: { getValue: () => options.position },
          forEachSample: (_time: JulianDate, visit: SampleVisitor) => samplesOf(options.samples ?? [])(visit),
        },
      },
      components: Object.fromEntries((options.components ?? []).map((name) => [name, {}])),
    };
  }

  function interval(satellites: PacedSatellite[], components: string[], cameraRadius?: number): number {
    const scene = stubScene(cameraRadius);
    const pacer = new RenderPacer(scene as unknown as Scene, { satellites: () => satellites, components: () => components, multiplier: () => 1 });
    // The first frame sees the camera arrive; the bound is taken once it has rested.
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    scene.preUpdate.raiseEvent(scene, time);
    now.mockReturnValue(1_000);
    scene.preUpdate.raiseEvent(scene, time);
    const seconds = scene.maximumRenderTimeChange;
    now.mockRestore();
    pacer.destroy();
    return seconds;
  }

  // Arktika-M 1's shell holds the default view's camera; its satellite and line stay far from it.
  const arktika = (samples: [number, number, number][]) => satellite({ position: new Cartesian3(-40_000_000, 0, 10_000_000), perigeeKm: 7_086, apogeeKm: 46_020, samples });
  const farLine: [number, number, number][] = [
    [-40_000_000, 0, 10_000_000],
    [-20_000_000, 0, 20_000_000],
    [0, 0, 30_000_000],
  ];

  test("measures an eccentric orbit's line where it is drawn when its shell holds the camera", () => {
    expect(interval([arktika(farLine)], ["Point", "Orbit"])).toBeGreaterThan(DEFAULT_LIMITS.floor);
    expect(interval([arktika(farLine)], ["Point", "Orbit track"])).toBeGreaterThan(DEFAULT_LIMITS.floor);
  });

  test("keeps the floor when that line passes near the camera, or has no sample", () => {
    expect(interval([arktika([...farLine, [26_000_000, 0, 0]])], ["Point", "Orbit track"])).toBe(DEFAULT_LIMITS.floor);
    expect(interval([arktika([])], ["Point", "Orbit"])).toBe(DEFAULT_LIMITS.floor);
  });

  test("widens a line's shell by half the longest step between samples and the drift", () => {
    // The camera 3,000 km under the orbit's shell, the satellite on the far side of the Earth.
    const high = (orbitalPeriod: number) => satellite({ position: new Cartesian3(-29_200_000, 0, 0), perigeeKm: 29_159, apogeeKm: 29_259, orbitalPeriod });
    // At the stub's 10 km/s, a day's 120 samples lie 7,200 km apart, 100 minutes' 500 km.
    expect(interval([high(1440)], ["Point", "Orbit track"])).toBe(DEFAULT_LIMITS.floor);
    expect(interval([high(100)], ["Point", "Orbit track"])).toBeGreaterThan(DEFAULT_LIMITS.floor);
  });

  test("measures at most 32 lines, holding the rest to their shells", () => {
    const many = Array.from({ length: 33 }, () => arktika(farLine));
    expect(interval(many, ["Point", "Orbit"])).toBe(DEFAULT_LIMITS.floor);
    expect(interval(many.slice(1), ["Point", "Orbit"])).toBeGreaterThan(DEFAULT_LIMITS.floor);
  });

  describe("ground tracks", () => {
    const leo = (components: string[]) => satellite({ position: new Cartesian3(-7_000_000, 0, 0), perigeeKm: 6_900, apogeeKm: 7_000, components });

    test("are paced from above the orbits, as the orbit's shell is", () => {
      // A line without a sample keeps its shell, which reaches 100 km further out.
      expect(interval([leo(["Point", "Ground track"])], ["Point", "Ground track"])).toBeCloseTo(interval([leo(["Point"])], ["Point", "Orbit track"]), 2);
      expect(interval([leo(["Point", "Ground track"])], ["Point", "Ground track"])).toBeGreaterThan(DEFAULT_LIMITS.floor);
    });

    test("keep the floor for a camera between the orbit and the ground", () => {
      expect(interval([leo(["Point", "Ground track"])], ["Point", "Ground track"], 6_800_000)).toBe(DEFAULT_LIMITS.floor);
    });

    test("count only where a satellite draws one", () => {
      // Below a LEO shell, the satellite on the far side of the Earth, which draws no ground track.
      expect(interval([leo(["Point"])], ["Point", "Ground track"], 6_800_000)).toBeGreaterThan(DEFAULT_LIMITS.floor);
    });
  });
});
