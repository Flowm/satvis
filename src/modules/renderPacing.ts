// Render on demand at the rate the view changes: `maximumRenderTimeChange` set each frame
// to the simulation time in which nothing drawn can move half a device pixel.
//
// Measured on an iPad mini 6, default view at x1: the fixed 1/30 s drew 26 frames a
// second and kept the GPU 52% busy; 0.5 s drew 2 and kept it 6% busy. A LEO satellite
// crosses about 0.5 device pixels a second there, so the frames in between were the same.

import { Cartesian3, Ellipsoid, type JulianDate, Matrix3, OrthographicOffCenterFrustum, PerspectiveFrustum } from "@cesium/core";
import { type Scene, SceneMode, Transforms } from "@cesium/engine";

import type { SampleVisitor } from "@/modules/util/GridPositionProperty";
import { BatchedLine } from "@/modules/util/PolylineBatch";
import { trajectoryWindow } from "@/modules/util/trajectoryWindow";

import { EARTH_ROTATION_RAD_S, MU_KM3_S2 } from "./Orbit";
import type Orbit from "./Orbit";
import { CONE_RADIUS_METERS } from "./satelliteGraphics";

/** What a satellite offers the pacer. */
export interface PacedSatellite {
  readonly props: {
    readonly orbit: Orbit;
    readonly trajectory: {
      readonly entityPosition?: { getValue(time: JulianDate, result?: Cartesian3): Cartesian3 | undefined };
      forEachSample(time: JulianDate, visit: SampleVisitor): void;
    };
  };
  /** Those it draws: a ground track only where its orbit has one. */
  readonly components: Readonly<Record<string, unknown>>;
  readonly model?: { readonly pending: boolean };
}

export interface PacerSources {
  satellites: () => readonly PacedSatellite[];
  components: () => readonly string[];
  multiplier: () => number;
}

export interface PacingLimits {
  /** Device pixels anything may move between two renders. */
  pixels: number;
  /** Simulation seconds; the interval before pacing, kept where the bound cannot be had. */
  floor: number;
  /** Simulation seconds; caps the wait for what no bound covers, such as the Sun's light moving. */
  ceiling: number;
}

export const DEFAULT_LIMITS: PacingLimits = { pixels: 0.5, floor: 1 / 30, ceiling: 1 };

/** Wall milliseconds between bounds; a moved camera renders anyway, so a stale bound only waits. */
const RECOMPUTE_MS = 250;

/** Wall milliseconds after the camera moved before the bound is taken again. */
const CAMERA_RECOMPUTE_MS = 50;

/**
 * The components the bound covers. Any other keeps the floor: links are drawn across the view.
 * Of the sessions in October 2026, about 97% drew only these.
 */
const PACED_COMPONENTS = new Set(["Point", "Label", "Orbit", "Orbit track", "Ground track", "Sensor cone", "3D model"]);

/**
 * Metres either side of the mean elements' perigee and apogee. SGP4's short-period terms
 * moved the ISS's radius up to 20 km past them (Orbit.test.ts).
 */
const SHELL_MARGIN_METRES = 50_000;

/** Metres from the Earth's centre, under the ground track's ribbon: the ellipsoid's polar radius is 6,356,752. */
const GROUND_RADIUS_METRES = 6_340_000;

/** Metres an orbit's line may lie off its samples: the drift ramped out of its loop, 54 km for NOAA 20. */
const LINE_DRIFT_METRES = 100_000;

/**
 * Radians toward the pole a satellite is taken to be in 2D, which stretches a parallel by
 * 1/cos(latitude). The native app's `RenderPacing.mapPixelRate` takes this alone; here the
 * bound must also hold until the next one, so a fast clock can widen it.
 */
const MAP_LATITUDE_MARGIN = (5 * Math.PI) / 180;

/** Radians: the latitude at which 2D's stretch stops growing, 11.5 there, as in the native app. */
const MAP_STRETCH_LATITUDE = (85 * Math.PI) / 180;

/** WGS84's first eccentricity squared, from geocentric to geodetic latitude. */
const WGS84_ECCENTRICITY_SQUARED = 1 - (Ellipsoid.WGS84.radii.z / Ellipsoid.WGS84.radii.x) ** 2;

/** The components that reach away from their satellite, which 2D takes at the widest stretch. */
export const REACHING_COMPONENTS: readonly string[] = ["Orbit", "Orbit track", "Sensor cone", "Ground track"];

/** The Earth's gravitational parameter, m³/s². */
const MU_M3_S2 = MU_KM3_S2 * 1e9;

/**
 * Satellites whose lines are measured at their samples in a bound, those whose shells bound
 * the rate most; the rest keep their shells. The native app's iPad mini spent 15 ms a frame
 * on all 16,762 active ones.
 */
const PLACED_LINES = 32;

/**
 * Angular rate (rad/s) of something `distance` metres away moving at `speed` m/s, at the
 * nearest it can come within `horizon` seconds. Infinite if it could reach the camera.
 */
export function angularRate(distance: number, speed: number, horizon: number): number {
  const nearest = distance - speed * horizon;
  return nearest > 0 ? speed / nearest : Infinity;
}

/** The most device pixels per radian anywhere in a perspective view: f(1 + tan²θ) at the corner. */
export function maxPixelsPerRadian(width: number, height: number, fov: number): number {
  const focal = Math.max(width, height) / 2 / Math.tan(fov / 2);
  const corner = Math.hypot(width, height) / 2 / focal;
  return focal * (1 + corner * corner);
}

/** Metres from a point `radius` from the centre to the shell between `inner` and `outer`. */
export function distanceToShell(radius: number, inner: number, outer: number): number {
  return Math.max(0, inner - radius, radius - outer);
}

/**
 * Metres from `camera` to the nearest of a line through the samples `forEach` visits, less half
 * the longest step between two and LINE_DRIFT_METRES. `turned` turns each sample with the Earth
 * to the time asked for, as an orbit held still in inertial space is drawn; an orbit track is not.
 * Undefined without a sample.
 */
export function lineDistance(forEach: (visit: SampleVisitor) => void, camera: Cartesian3, turned: boolean): number | undefined {
  let nearest = Infinity;
  let chord = 0;
  // NaN until a sample is taken, so the first step is not a chord.
  let previousX = NaN;
  let previousY = NaN;
  let previousZ = NaN;
  forEach((sampleX, sampleY, z, seconds) => {
    let x = sampleX;
    let y = sampleY;
    if (turned) {
      const cos = Math.cos(EARTH_ROTATION_RAD_S * seconds);
      const sin = Math.sin(EARTH_ROTATION_RAD_S * seconds);
      x = cos * sampleX - sin * sampleY;
      y = sin * sampleX + cos * sampleY;
    }
    const step = Math.hypot(x - previousX, y - previousY, z - previousZ);
    previousX = x;
    previousY = y;
    previousZ = z;
    // NaN where SGP4 refused the sample.
    if (!Number.isFinite(x + y + z)) {
      return;
    }
    nearest = Math.min(nearest, Math.hypot(x - camera.x, y - camera.y, z - camera.z));
    if (Number.isFinite(step)) {
      chord = Math.max(chord, step);
    }
  });
  return Number.isFinite(nearest) ? Math.max(0, nearest - chord / 2 - LINE_DRIFT_METRES) : undefined;
}

/** A satellite whose line's shell bounds the rate more than it does, to be measured where it is drawn. */
interface LineToPlace {
  /** rad/s, the line held to its shell. */
  shell: number;
  /** Whose line it is. */
  satellite: PacedSatellite;
  /** Its orbit's, for the line's turn. */
  bound: OrbitBound;
  /** m/s, the satellite's where it is (`lineSpeed`). */
  speed: number;
}

/**
 * Metres from `camera` to the nearest of a batched line's segments through `points` (x, y, z
 * each), as they are drawn: turned by `rotation` where the batch turns them. Undefined without a
 * segment.
 */
export function polylineDistance(points: ArrayLike<number>, camera: Cartesian3, rotation?: Matrix3): number | undefined {
  let nearest = Infinity;
  const at = (index: number, result: Cartesian3) => {
    Cartesian3.fromArray(points as number[], index * 3, result);
    return rotation ? Matrix3.multiplyByVector(rotation, result, result) : result;
  };
  const [a, b, along, foot] = [new Cartesian3(), new Cartesian3(), new Cartesian3(), new Cartesian3()];
  at(0, b);
  for (let index = 1; index < points.length / 3; index += 1) {
    Cartesian3.clone(b, a);
    at(index, b);
    Cartesian3.subtract(b, a, along);
    const squared = Cartesian3.magnitudeSquared(along);
    const t = squared > 0 ? Math.min(Math.max(Cartesian3.dot(Cartesian3.subtract(camera, a, foot), along) / squared, 0), 1) : 0;
    nearest = Math.min(nearest, Cartesian3.distance(Cartesian3.add(a, Cartesian3.multiplyByScalar(along, t, foot), foot), camera));
  }
  return Number.isFinite(nearest) ? nearest : undefined;
}

/** How far from the Earth's centre an orbit runs, and how fast anything drawn of it moves. */
export interface OrbitBound {
  /** m/s in the Earth-fixed frame. */
  speed: number;
  /** rad/s; at least how fast the satellite's nadir turns, and with it its sensor cone. */
  turnRate: number;
  /** Earth-centred metres, with SHELL_MARGIN_METRES. */
  inner: number;
  /** Earth-centred metres, with SHELL_MARGIN_METRES. */
  outer: number;
  /** Metres, at most between two neighbouring samples. */
  chord: number;
}

/**
 * Metres a second at most for a satellite `radius` metres from the Earth's centre, and an orbit
 * track's end a period ahead: vis-viva on the shell's semi-major axis and the Earth's rotation, a
 * tenth on top. Never more than the shell's `speed`, which an eccentric orbit far from perigee is
 * well under.
 */
export function lineSpeed(radius: number, bound: Pick<OrbitBound, "inner" | "outer" | "speed">): number {
  const nearest = Math.max(radius - SHELL_MARGIN_METRES, bound.inner, 1);
  const inertial = Math.sqrt(MU_M3_S2 * Math.max(2 / nearest - 2 / (bound.inner + bound.outer), 0));
  return Math.min(1.1 * (inertial + EARTH_ROTATION_RAD_S * radius), bound.speed);
}

/**
 * Metres a second at most of an orbit's line, held still in inertial space, where it runs within
 * `radius` metres of the Earth's centre: the Earth's turn there, a tenth on top. Bounded at its
 * apogee instead, MMS 4's line 2,000 km from an iPad mini's camera drew the native app's every
 * other frame or every frame, not every fifth.
 */
export function turningLineSpeed(radius: number, bound: Pick<OrbitBound, "outer" | "speed">): number {
  return Math.min(1.1 * EARTH_ROTATION_RAD_S * Math.min(radius, bound.outer + LINE_DRIFT_METRES), bound.speed);
}

/** Simulation seconds in which motion at `angularRateRadS` crosses `limits.pixels`, clamped to the limits. */
export function renderTimeChange(angularRateRadS: number, pixelsPerRadian: number, limits: PacingLimits = DEFAULT_LIMITS): number {
  const seconds = limits.pixels / (angularRateRadS * pixelsPerRadian);
  if (Number.isNaN(seconds)) {
    return limits.floor;
  }
  return Math.min(Math.max(seconds, limits.floor), limits.ceiling);
}

/** Sets `scene.maximumRenderTimeChange` before each render decision. */
export class RenderPacer {
  readonly #scene: Scene;

  readonly #sources: PacerSources;

  readonly #limits: PacingLimits;

  readonly #bounds = new WeakMap<Orbit, OrbitBound>();

  readonly #position = new Cartesian3();

  /** Each satellite's orbit bound in the last bound taken, in `sources.satellites()`'s order. */
  readonly #satelliteBounds: OrbitBound[] = [];

  /** rad/s, the most each satellite could add from its shell in the last bound taken. */
  #most = new Float64Array(0);

  /** Indices of the satellites to visit, the most first. */
  readonly #order: number[] = [];

  /** rad/s, the last bound's, from which the next sorts only those that could matter. */
  #lastRate = 0;

  /** `Transforms.computeIcrfToFixedMatrix`'s result, reused every bound. */
  readonly #icrfToFixed = new Matrix3();

  readonly #cameraAt = new Cartesian3();

  readonly #cameraFacing = new Cartesian3();

  #computedAt = -Infinity;

  #cameraMovedAt: number | undefined;

  #interval: number;

  readonly #remove: () => void;

  constructor(scene: Scene, sources: PacerSources, limits: PacingLimits = DEFAULT_LIMITS) {
    this.#scene = scene;
    this.#sources = sources;
    this.#limits = limits;
    this.#interval = limits.floor;
    this.#remove = scene.preUpdate.addEventListener((_scene: Scene, time: JulianDate) => this.#pace(time));
  }

  destroy(): void {
    this.#remove();
    this.#scene.maximumRenderTimeChange = this.#limits.floor;
  }

  #pace(time: JulianDate): void {
    const scene = this.#scene;
    // The sky view, the benchmark and the Graphics switch draw every frame: no bound to pay for.
    if (!scene.requestRenderMode) {
      this.#computedAt = -Infinity;
      return;
    }
    const now = performance.now();
    const { camera } = scene;
    if (!Cartesian3.equalsEpsilon(camera.positionWC, this.#cameraAt, 0, 1e-3) || !Cartesian3.equalsEpsilon(camera.directionWC, this.#cameraFacing, 1e-9)) {
      Cartesian3.clone(camera.positionWC, this.#cameraAt);
      Cartesian3.clone(camera.directionWC, this.#cameraFacing);
      this.#cameraMovedAt = now;
    }
    if (this.#cameraMovedAt !== undefined) {
      // A moving camera renders each frame anyway; once it rests, the bound is taken from where it stopped.
      if (now - this.#cameraMovedAt < CAMERA_RECOMPUTE_MS) {
        scene.maximumRenderTimeChange = this.#limits.floor;
        return;
      }
      this.#cameraMovedAt = undefined;
      this.#computedAt = -Infinity;
    }
    if (now - this.#computedAt >= RECOMPUTE_MS) {
      this.#interval = this.#bound(time);
      this.#computedAt = now;
    }
    scene.maximumRenderTimeChange = this.#interval;
  }

  /** The interval for the view as it is now, safe until the next bound. */
  #bound(time: JulianDate): number {
    const scene = this.#scene;
    const { camera } = scene;
    const frustum = camera.frustum;
    const components = this.#sources.components();
    if (!components.every((name) => PACED_COMPONENTS.has(name))) {
      return this.#limits.floor;
    }
    // Simulation seconds until the next bound and through the render after it.
    const horizon = (RECOMPUTE_MS / 1000) * Math.abs(this.#sources.multiplier()) + this.#limits.ceiling;
    if (scene.mode === SceneMode.SCENE2D && frustum instanceof OrthographicOffCenterFrustum && frustum.left !== undefined && frustum.right !== undefined) {
      return this.#mapBound(time, components, horizon, scene.drawingBufferWidth / (frustum.right - frustum.left));
    }
    if (scene.mode !== SceneMode.SCENE3D || !(frustum instanceof PerspectiveFrustum) || frustum.fov === undefined) {
      return this.#limits.floor;
    }
    const pixelsPerRadian = maxPixelsPerRadian(scene.drawingBufferWidth, scene.drawingBufferHeight, frustum.fov);
    const orbitLine = components.includes("Orbit");
    const trackLine = components.includes("Orbit track");
    const lines = orbitLine || trackLine;
    const groundTracks = components.includes("Ground track");
    const cone = components.includes("Sensor cone");
    const models = components.includes("3D model");
    const cameraPosition = camera.positionWC;
    const cameraRadius = Cartesian3.magnitude(cameraPosition);
    // The batched orbits' turn into the fixed frame; undefined until the IAU data loads.
    const icrfToFixed = Transforms.computeIcrfToFixedMatrix(time, this.#icrfToFixed);

    // Radians a second past which the floor stands, whatever else moves.
    const enough = this.#limits.pixels / (this.#limits.floor * pixelsPerRadian);
    // A line's rate where it is drawn, never past its shell's.
    const place = ({ shell, satellite, bound, speed }: LineToPlace): number => {
      const { trajectory } = satellite.props;
      const forEach = (visit: SampleVisitor) => trajectory.forEachSample(time, visit);
      // Batched, a line is where its points are drawn; a path, for the tracked satellite, where its
      // samples are.
      const drawn = (name: string, rotation?: Matrix3) => {
        const line = satellite.components[name];
        return line instanceof BatchedLine ? polylineDistance(line.points, cameraPosition, rotation) : undefined;
      };
      const orbit = orbitLine ? ((icrfToFixed && drawn("Orbit", icrfToFixed)) ?? lineDistance(forEach, cameraPosition, true)) : undefined;
      const track = trackLine ? (drawn("Orbit track") ?? lineDistance(forEach, cameraPosition, false)) : undefined;
      // Without a sample, the shell stands.
      if (orbit === undefined && track === undefined) {
        return shell;
      }
      // The batched orbit, rebuilt every half period, turns with the Earth within the camera's
      // radius and its distance; an orbit track's ends move at the satellite's speed.
      const placed = Math.max(
        orbit === undefined ? 0 : angularRate(orbit, turningLineSpeed(cameraRadius + orbit, bound), horizon),
        track === undefined ? 0 : angularRate(track, speed, horizon),
      );
      return Math.min(shell, placed);
    };

    const satellites = this.#sources.satellites();
    const lineShell = (bound: OrbitBound) =>
      // A line's far points can pass closer than the satellite. It runs inside its samples by half a
      // chord and off them by the drift. A camera within an eccentric orbit's shell (Arktika-M's runs
      // 7,090 to 46,015 km) is measured to the line.
      angularRate(distanceToShell(cameraRadius, bound.inner - bound.chord / 2 - LINE_DRIFT_METRES, bound.outer + LINE_DRIFT_METRES), bound.speed, horizon);
    // The ribbon lies on the ground under the orbit, its clipped ends following the subpoint, slower
    // than the satellite.
    const groundTrackRate = (bound: OrbitBound) => angularRate(distanceToShell(cameraRadius, GROUND_RADIUS_METRES, bound.outer), bound.speed, horizon);
    // Carried with the satellite and turned with its nadir, all within CONE_RADIUS_METERS of it.
    const coneRate = (distance: number, bound: OrbitBound) => angularRate(distance - CONE_RADIUS_METERS, bound.speed + bound.turnRate * CONE_RADIUS_METERS, horizon);

    // The most each satellite could add from its shell alone, which no position in it comes nearer
    // than: all but a hundred of 16,894 active ones then need no position.
    const bounds = this.#satelliteBounds;
    bounds.length = satellites.length;
    if (this.#most.length < satellites.length) {
      this.#most = new Float64Array(Math.ceil(satellites.length * 1.25));
    }
    const most = this.#most;
    for (const [index, satellite] of satellites.entries()) {
      // Cesium loads a model only on rendered frames.
      if (models && satellite.model?.pending) {
        return this.#limits.floor;
      }
      const bound = this.#orbitBound(satellite.props.orbit);
      const shell = distanceToShell(cameraRadius, bound.inner, bound.outer);
      bounds[index] = bound;
      most[index] = Math.max(angularRate(shell, bound.speed, horizon), lines ? lineShell(bound) : 0, groundTracks ? groundTrackRate(bound) : 0, cone ? coneRate(shell, bound) : 0);
    }

    let rate = 0;
    // Lines whose shells bound the rate more than their satellites do are measured where they are
    // drawn, PLACED_LINES of them under the floor, those that bound it most first; the rest keep
    // their shells.
    let measured = 0;
    const visit = (index: number) => {
      const satellite = satellites[index]!;
      const bound = bounds[index]!;
      const position = satellite.props.trajectory.entityPosition?.getValue(time, this.#position);
      if (!position) {
        return;
      }
      const distance = Cartesian3.distance(cameraPosition, position);
      const own = angularRate(distance, bound.speed, horizon);
      rate = Math.max(rate, own);
      if (lines) {
        const shell = lineShell(bound);
        if (shell > own && shell > rate) {
          if (shell < enough && measured === PLACED_LINES) {
            rate = shell;
          } else {
            // As a line whose shell holds the camera: held to its shell, a 33rd kept the floor.
            measured += shell < enough ? 1 : 0;
            rate = Math.max(rate, place({ shell, satellite, bound, speed: lineSpeed(Cartesian3.magnitude(position), bound) }));
          }
        }
      }
      if (groundTracks && satellite.components["Ground track"] !== undefined) {
        rate = Math.max(rate, groundTrackRate(bound));
      }
      if (cone) {
        rate = Math.max(rate, coneRate(distance, bound));
      }
    };
    // Visits those that could add more than `above` and at most `atMost`, the most first, until none
    // can raise the rate; true once it passes the floor.
    const visitBetween = (above: number, atMost: number): boolean => {
      const order = this.#order;
      order.length = 0;
      for (let index = 0; index < satellites.length; index += 1) {
        if (most[index]! > above && most[index]! <= atMost) {
          order.push(index);
        }
      }
      order.sort((a, b) => most[b]! - most[a]!);
      for (const index of order) {
        if (most[index]! <= rate) {
          break;
        }
        visit(index);
        if (rate >= enough) {
          return true;
        }
      }
      return false;
    };
    // Half the last bound's rate leaves the hundred or so that matter to sort; where the rate falls
    // under it, those between are visited too.
    const seed = this.#lastRate / 2;
    const floored = visitBetween(seed, Infinity) || (rate < seed && visitBetween(rate, seed));
    this.#lastRate = floored ? enough : rate;
    if (floored) {
      return this.#limits.floor;
    }
    return renderTimeChange(rate, pixelsPerRadian, this.#limits);
  }

  /**
   * The 2D map's interval: each satellite at its ground speed, stretched as the map stretches
   * its latitude. REACHING_COMPONENTS take the furthest stretch: a line, a cone, or a ground
   * track's swath (METimage's 1,335 km either side).
   */
  #mapBound(time: JulianDate, components: readonly string[], horizon: number, pixelsPerMetre: number): number {
    const reaching = REACHING_COMPONENTS.some((name) => components.includes(name));
    const models = components.includes("3D model");
    let rate = 0;
    for (const satellite of this.#sources.satellites()) {
      // Cesium loads a model only on rendered frames.
      if (models && satellite.model?.pending) {
        return this.#limits.floor;
      }
      const bound = this.#orbitBound(satellite.props.orbit);
      let latitude = MAP_STRETCH_LATITUDE;
      if (!reaching) {
        const position = satellite.props.trajectory.entityPosition?.getValue(time, this.#position);
        if (!position) {
          continue;
        }
        // Geodetic as on the ground, never nearer the equator than above it; Cesium's exact
        // conversion iterates, for every satellite.
        const geocentric = Math.abs(Math.asin(position.z / Cartesian3.magnitude(position)));
        const geodetic = Math.atan(Math.tan(geocentric) / (1 - WGS84_ECCENTRICITY_SQUARED));
        latitude = Math.min(geodetic + Math.max(MAP_LATITUDE_MARGIN, bound.turnRate * horizon), MAP_STRETCH_LATITUDE);
      }
      // Infinite or NaN for an unbounded orbit, which keeps the floor.
      rate = Math.max(rate, (bound.speed * Ellipsoid.WGS84.maximumRadius) / bound.inner / Math.cos(latitude));
    }
    return renderTimeChange(rate, pixelsPerMetre, this.#limits);
  }

  /** `orbit`'s bound, kept for as long as the orbit is. */
  #orbitBound(orbit: Orbit): OrbitBound {
    let bound = this.#bounds.get(orbit);
    if (!bound) {
      const [perigeeKm, apogeeKm] = orbit.radiusRangeKm;
      // NaN for an element set SGP4 cannot use: Infinity then keeps the floor.
      const finite = (value: number) => (Number.isFinite(value) ? value : Infinity);
      const speed = finite(orbit.maxFixedSpeedKmS * 1000);
      const inner = Number.isFinite(perigeeKm) ? Math.max(0, perigeeKm * 1000 - SHELL_MARGIN_METRES) : 0;
      bound = {
        speed,
        // The fixed-frame speed over the perigee radius exceeds any angular rate of the radius vector.
        turnRate: inner > 0 ? speed / inner : Infinity,
        inner,
        outer: Number.isFinite(apogeeKm) ? apogeeKm * 1000 + SHELL_MARGIN_METRES : Infinity,
        chord: finite(speed * trajectoryWindow(orbit.orbitalPeriod).stepSeconds),
      };
      this.#bounds.set(orbit, bound);
    }
    return bound;
  }
}
