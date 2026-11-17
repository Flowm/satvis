import { Cartesian3, Ellipsoid, Event, JulianDate, Math as CesiumMath, Matrix3, OrthographicOffCenterFrustum, PerspectiveFrustum } from "@cesium/core";
import { type Scene, SceneMode } from "@cesium/engine";
import { describe, expect, test, vi } from "vitest";

import type { SampleVisitor } from "@/modules/util/GridPositionProperty";
import { BatchedLine } from "@/modules/util/PolylineBatch";

import { EARTH_ROTATION_RAD_S } from "./Orbit";
import type Orbit from "./Orbit";
import {
  DEFAULT_LIMITS,
  type PacedSatellite,
  REACHING_COMPONENTS,
  RenderPacer,
  angularRate,
  distanceToShell,
  lineDistance,
  lineSpeed,
  maxPixelsPerRadian,
  polylineDistance,
  renderTimeChange,
  turningLineSpeed,
} from "./renderPacing";

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

describe("polylineDistance", () => {
  const points = [10_000_000, 0, 0, 10_000_000, 400_000, 0, 10_000_000, 600_000, 0];

  test("is the distance to the nearest segment: at its foot beside it, at its end beyond it", () => {
    expect(polylineDistance(points, new Cartesian3(12_000_000, 200_000, 0))).toBeCloseTo(2_000_000);
    expect(polylineDistance(points, new Cartesian3(30_000_000, 900_000, 0))).toBeCloseTo(Math.hypot(20_000_000, 300_000));
  });

  test("turns the points as the batch draws them, and is undefined without a segment", () => {
    // A quarter turn about the z axis takes the line onto the y axis.
    const quarter = Matrix3.fromRotationZ(Math.PI / 2);
    expect(polylineDistance(points, new Cartesian3(-200_000, 12_000_000, 0), quarter)).toBeCloseTo(2_000_000, -1);
    expect(polylineDistance(points.slice(0, 3), new Cartesian3(12_000_000, 0, 0))).toBeUndefined();
  });
});

describe("lineSpeed", () => {
  // Arktika-M 1's shell, metres, and the shell's bound, the perigee's speed and the Earth's turn at apogee.
  const shell = { inner: 7_036_000, outer: 46_070_000, speed: 14_600 };

  test("is the satellite's speed where it is, well under the shell's near apogee", () => {
    const apogee = lineSpeed(46_000_000, shell);
    expect(apogee).toBeGreaterThan(1.1 * EARTH_ROTATION_RAD_S * 46_000_000);
    expect(apogee).toBeLessThan(6_000);
    expect(lineSpeed(7_100_000, shell)).toBeGreaterThan(10_000);
    expect(lineSpeed(7_100_000, shell)).toBeLessThan(shell.speed);
  });
});

describe("turningLineSpeed", () => {
  const shell = { outer: 46_070_000, speed: 14_600 };

  test("is the Earth's turn within the radius, at most the outer one's and the drift's, and the shell's", () => {
    expect(turningLineSpeed(20_000_000, shell)).toBeCloseTo(1.1 * EARTH_ROTATION_RAD_S * 20_000_000);
    expect(turningLineSpeed(1e9, shell)).toBeCloseTo(1.1 * EARTH_ROTATION_RAD_S * (shell.outer + DRIFT));
    expect(turningLineSpeed(1e9, { ...shell, speed: 1_000 })).toBe(1_000);
  });

  test("bounds every point of a line turning with the Earth, seen from the camera, by its nearest", () => {
    const molniya = { outer: 46_050_000, speed: Infinity };
    // A Molniya-like ellipse in inertial space, 7,000 to 46,000 km from the centre, tilted 63.4°.
    const tilt = (63.4 * Math.PI) / 180;
    const nodes = Array.from({ length: 120 }, (_, index): [number, number, number] => {
      const anomaly = (2 * Math.PI * index) / 120;
      const radius = (26_500_000 * (1 - 0.736 ** 2)) / (1 + 0.736 * Math.cos(anomaly));
      return [radius * Math.cos(anomaly), radius * Math.sin(anomaly) * Math.cos(tilt), radius * Math.sin(anomaly) * Math.sin(tilt)];
    });
    // The line as drawn after `seconds`: its nodes turned with the Earth, and the chords between them.
    const line = (seconds: number) => {
      const angle = -EARTH_ROTATION_RAD_S * seconds;
      const turned = nodes.map(([x, y, z]) => new Cartesian3(Math.cos(angle) * x - Math.sin(angle) * y, Math.sin(angle) * x + Math.cos(angle) * y, z));
      return turned.flatMap((node, index) => [0, 0.25, 0.5, 0.75].map((t) => Cartesian3.lerp(node, turned[(index + 1) % turned.length]!, t, new Cartesian3())));
    };
    const [now, later] = [line(0), line(0.5)];
    const offset = 3_000_000;
    const cameras = [
      // 15,000 km inside the apogee, which lies in the equator's plane: there the bound is nearly met.
      new Cartesian3(-31_000_000, 0, 0),
      new Cartesian3(25_000_000, 0, 0),
      new Cartesian3(0, -60_000_000, 0),
      new Cartesian3(0, 0, 30_000_000),
      ...now
        .filter((_, index) => index % 40 === 0)
        .map((point) => Cartesian3.add(point, Cartesian3.multiplyByScalar(Cartesian3.normalize(point, new Cartesian3()), offset, new Cartesian3()), new Cartesian3())),
    ];
    for (const camera of cameras) {
      // Samples at the instant asked for, so turned by nothing.
      const distance = lineDistance(samplesOf(nodes, 0, 0), camera, true)!;
      // Within the margin the bound is infinite, which proves nothing.
      expect(distance).toBeGreaterThan(0);
      const bound = turningLineSpeed(Cartesian3.magnitude(camera) + distance, molniya) / distance;
      for (const [index, point] of now.entries()) {
        const speed = Cartesian3.distance(point, later[index]!) / 0.5;
        expect(speed / Cartesian3.distance(point, camera)).toBeLessThanOrEqual(bound);
      }
    }
    // By the perigee, far under the apogee's turn.
    expect(turningLineSpeed(7_000_000 * 1.05 + 2e6, molniya)).toBeLessThan(0.5 * 1.1 * EARTH_ROTATION_RAD_S * molniya.outer);
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
    drawn?: Record<string, unknown>;
    /** Metres; by default the orbit's. */
    radiusRange?: readonly [number, number];
  }): PacedSatellite {
    const orbit = { radiusRangeKm: [options.perigeeKm, options.apogeeKm], maxFixedSpeedKmS: 10, orbitalPeriod: options.orbitalPeriod ?? 100 } as unknown as Orbit;
    return {
      props: {
        orbit,
        trajectory: {
          entityPosition: { getValue: () => options.position },
          radiusRange: "radiusRange" in options ? options.radiusRange : [options.perigeeKm * 1000, options.apogeeKm * 1000],
          forEachSample: (_time: JulianDate, visit: SampleVisitor) => samplesOf(options.samples ?? [])(visit),
        },
      },
      components: { ...Object.fromEntries((options.components ?? []).map((name) => [name, {}])), ...options.drawn },
    };
  }

  /** The whole 2D map across the drawing buffer's width. */
  function stubMap() {
    const scene = stubScene();
    const halfWidth = Math.PI * Ellipsoid.WGS84.maximumRadius;
    const frustum = new OrthographicOffCenterFrustum();
    Object.assign(frustum, { left: -halfWidth, right: halfWidth, bottom: -halfWidth / 2, top: halfWidth / 2 });
    return { ...scene, mode: SceneMode.SCENE2D, camera: { ...scene.camera, frustum } };
  }

  /** The interval the pacer sets for `satellites` drawing `components`, once the camera has rested in `scene`. */
  function interval(satellites: PacedSatellite[], components: string[], scene: Pick<ReturnType<typeof stubScene>, "preUpdate" | "maximumRenderTimeChange"> = stubScene()): number {
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

  test("measures a batched line where its points are drawn, not its samples", () => {
    const near = new BatchedLine([new Cartesian3(26_200_000, -1_000_000, 0), new Cartesian3(26_200_000, 1_000_000, 0)]);
    const drawn = satellite({ position: new Cartesian3(-40_000_000, 0, 10_000_000), perigeeKm: 7_086, apogeeKm: 46_020, samples: farLine, drawn: { "Orbit track": near } });
    expect(interval([arktika(farLine)], ["Point", "Orbit track"])).toBeGreaterThan(DEFAULT_LIMITS.floor);
    expect(interval([drawn], ["Point", "Orbit track"])).toBe(DEFAULT_LIMITS.floor);
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

  test("measures every line whose shell holds the camera", () => {
    // Held to its shell, the 33rd alone kept the floor.
    const many = Array.from({ length: 33 }, () => arktika(farLine));
    expect(interval(many, ["Point", "Orbit"])).toBeGreaterThan(DEFAULT_LIMITS.floor);
  });

  test("measures at most 32 of the lines whose shells bound the rate under the floor, holding the rest to their shells", () => {
    // The camera 2,650 km under each line's shell, each satellite and line on the far side of the Earth.
    const high = () => satellite({ position: new Cartesian3(-29_200_000, 0, 0), perigeeKm: 29_159, apogeeKm: 29_259, samples: [[-29_200_000, 0, 0]] });
    const shell = interval(Array.from({ length: 33 }, high), ["Point", "Orbit"]);
    expect(shell).toBeGreaterThan(DEFAULT_LIMITS.floor);
    expect(shell).toBeLessThan(interval(Array.from({ length: 32 }, high), ["Point", "Orbit"]));
  });

  test("bounds an orbit's line near the camera by the Earth's turn there, not at its apogee", () => {
    // 2,000 km off the camera; at the apogee's turn, MMS 4's line held the native app to every other frame.
    const samples = [-1, -0.5, 0, 0.5, 1].map((z): [number, number, number] => [26_109_000, 2_150_000, z * 1_000_000]);
    const near = (apogeeKm: number) => satellite({ position: new Cartesian3(-40_000_000, 0, 10_000_000), perigeeKm: 7_086, apogeeKm, samples });
    expect(interval([near(46_020)], ["Point", "Orbit"])).toBeCloseTo(interval([near(177_000)], ["Point", "Orbit"]), 6);
    expect(interval([near(177_000)], ["Point", "Orbit"])).toBeGreaterThan(3 * DEFAULT_LIMITS.floor);
  });

  test("reads only the positions that could raise the rate, and every one it needs once the rate falls", () => {
    let reads = 0;
    const counted = (options: Parameters<typeof satellite>[0]): PacedSatellite => {
      const paced = satellite(options);
      return {
        ...paced,
        props: {
          ...paced.props,
          trajectory: {
            ...paced.props.trajectory,
            entityPosition: {
              getValue: () => {
                reads += 1;
                return options.position;
              },
            },
          },
        },
      };
    };
    // One 1,009 km under the camera, a thousand low ones on the far side of the Earth.
    const near = counted({ position: new Cartesian3(25_100_000, 0, 0), perigeeKm: 25_000, apogeeKm: 25_200 });
    const low = Array.from({ length: 1000 }, (_, index) => counted({ position: new Cartesian3(-7_000_000, index * 1000, 0), perigeeKm: 6_900, apogeeKm: 7_000 }));
    let satellites = [near, ...low];
    const scene = stubScene();
    const pacer = new RenderPacer(scene as unknown as Scene, { satellites: () => satellites, components: () => ["Point"], multiplier: () => 1 });
    const now = vi.spyOn(performance, "now");
    const bound = (at: number) => {
      now.mockReturnValue(at);
      scene.preUpdate.raiseEvent(scene, time);
      return scene.maximumRenderTimeChange;
    };
    // At the stub's 10 km/s over the next bound and the ceiling, 1.25 s.
    const pixelsPerRadian = maxPixelsPerRadian(2266, 1218, CesiumMath.toRadians(60));
    const expected = (distance: number) => renderTimeChange(angularRate(distance, 10_000, 1.25), pixelsPerRadian);
    bound(0);
    expect(bound(1_000)).toBeCloseTo(expected(1_009_000), 9);
    expect(reads).toBe(1);
    satellites = low;
    expect(bound(2_000)).toBeCloseTo(expected(33_109_000), 9);
    expect(reads).toBe(1001);
    now.mockRestore();
    pacer.destroy();
  });

  test("holds a satellite to the shell its samples run in, and one without samples to where it is", () => {
    const pixelsPerRadian = maxPixelsPerRadian(2266, 1218, CesiumMath.toRadians(60));
    const expected = (distance: number) => renderTimeChange(angularRate(distance, 10_000, 1.25), pixelsPerRadian);
    // 5,000 km off the camera, in its shell.
    const steady = satellite({ position: new Cartesian3(21_109_000, 0, 0), perigeeKm: 21_000, apogeeKm: 21_200 });
    // Its element set's low shell held far from the camera, it is propagated 1,009 km under it.
    const drifted = (radiusRange?: readonly [number, number]) => satellite({ position: new Cartesian3(25_100_000, 0, 0), perigeeKm: 6_900, apogeeKm: 7_000, radiusRange });
    expect(interval([steady, drifted([25_000_000, 25_200_000])], ["Point"])).toBeCloseTo(expected(1_009_000), 9);
    expect(interval([steady, drifted(undefined)], ["Point"])).toBeCloseTo(expected(1_009_000), 9);
    expect(interval([steady], ["Point"])).toBeCloseTo(expected(5_000_000), 9);
  });

  test("visits a satellite whose line's shell could raise the rate though its own cannot", () => {
    const line = (x: number) => ({ "Orbit track": new BatchedLine([new Cartesian3(x, -1_000_000, 0), new Cartesian3(x, 1_000_000, 0)]) });
    // 3,200 km under the camera, its line far off.
    const steady = satellite({ position: new Cartesian3(22_909_000, 0, 0), perigeeKm: 22_800, apogeeKm: 23_000, drawn: line(-40_000_000) });
    // On the far side, its shell 3,841 km over the camera; a day's samples 7,200 km apart widen its
    // line's to the camera, and its line passes 1,800 km over it.
    const lined = satellite({ position: new Cartesian3(-30_050_000, 0, 0), perigeeKm: 30_000, apogeeKm: 30_100, orbitalPeriod: 1440, drawn: line(27_909_000) });
    expect(interval([steady, lined], ["Point", "Orbit track"])).toBeLessThan(interval([steady], ["Point", "Orbit track"]));
  });

  describe("ground tracks", () => {
    const leo = (components: string[]) => satellite({ position: new Cartesian3(-7_000_000, 0, 0), perigeeKm: 6_900, apogeeKm: 7_000, components });

    test("are paced from above the orbits, as the orbit's shell is", () => {
      // A line without a sample keeps its shell, which reaches 100 km further out.
      expect(interval([leo(["Point", "Ground track"])], ["Point", "Ground track"])).toBeCloseTo(interval([leo(["Point"])], ["Point", "Orbit track"]), 2);
      expect(interval([leo(["Point", "Ground track"])], ["Point", "Ground track"])).toBeGreaterThan(DEFAULT_LIMITS.floor);
    });

    test("keep the floor for a camera between the orbit and the ground", () => {
      expect(interval([leo(["Point", "Ground track"])], ["Point", "Ground track"], stubScene(6_800_000))).toBe(DEFAULT_LIMITS.floor);
    });

    test("count only where a satellite draws one", () => {
      // Below a LEO shell, the satellite on the far side of the Earth, which draws no ground track.
      expect(interval([leo(["Point"])], ["Point", "Ground track"], stubScene(6_800_000))).toBeGreaterThan(DEFAULT_LIMITS.floor);
    });
  });

  describe("in 2D", () => {
    const at = (latitude: number) => satellite({ position: Cartesian3.fromRadians(0, CesiumMath.toRadians(latitude), 500_000), perigeeKm: 6_871, apogeeKm: 6_881 });

    test("paces a satellite by its ground speed, stretched with its latitude", () => {
      const equator = interval([at(0)], ["Point"], stubMap());
      expect(equator).toBeGreaterThan(DEFAULT_LIMITS.floor);
      // 10 km/s at the shell's inner 6,821 km, carried to the map's radius and stretched as at 5°.
      const metresPerSecond = (10_000 * Ellipsoid.WGS84.maximumRadius) / 6_821_000 / Math.cos(CesiumMath.toRadians(5));
      expect(equator).toBeCloseTo(0.5 / ((metresPerSecond * 2266) / (2 * Math.PI * Ellipsoid.WGS84.maximumRadius)), 4);
      expect(interval([at(60)], ["Point"], stubMap())).toBeLessThan(equator);
    });

    test("takes what reaches away from a satellite at the stretch's limit, and keeps the floor for what has no bound", () => {
      for (const reaching of REACHING_COMPONENTS) {
        expect(interval([at(0)], ["Point", reaching], stubMap()), reaching).toBeCloseTo(interval([at(85)], ["Point"], stubMap()), 6);
      }
      expect(interval([at(0)], ["Point", "Ground station link"], stubMap())).toBe(DEFAULT_LIMITS.floor);
    });
  });
});
