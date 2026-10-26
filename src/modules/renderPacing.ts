// Render on demand at the rate the view changes: `maximumRenderTimeChange` set each frame
// to the simulation time in which nothing drawn can move half a device pixel.
//
// Measured on an iPad mini 6, default view at x1: the fixed 1/30 s drew 26 frames a
// second and kept the GPU 52% busy; 0.5 s drew 2 and kept it 6% busy. A LEO satellite
// crosses about 0.5 device pixels a second there, so the frames in between were the same.

import { Cartesian3, type JulianDate, PerspectiveFrustum } from "@cesium/core";
import { type Scene, SceneMode } from "@cesium/engine";

import { EARTH_ROTATION_RAD_S, MU_KM3_S2 } from "./Orbit";
import type Orbit from "./Orbit";
import { CONE_RADIUS_METERS } from "./satelliteGraphics";
import type { SampleVisitor } from "./util/GridPositionProperty";
import { trajectoryWindow } from "./util/trajectoryWindow";

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
 * Metres a second at most for anything on the line of an orbit whose satellite is `radius` metres
 * from the Earth's centre: vis-viva on the shell's semi-major axis and the Earth's rotation, a
 * tenth on top. With `turned`, at least the Earth's turn at the outer radius. Never more than
 * the shell's `speed`, which an eccentric orbit far from perigee is well under.
 */
export function lineSpeed(radius: number, bound: Pick<OrbitBound, "inner" | "outer" | "speed">, turned: boolean): number {
  const nearest = Math.max(radius - SHELL_MARGIN_METRES, bound.inner, 1);
  const inertial = Math.sqrt(MU_M3_S2 * Math.max(2 / nearest - 2 / (bound.inner + bound.outer), 0));
  let speed = 1.1 * (inertial + EARTH_ROTATION_RAD_S * radius);
  if (turned) {
    speed = Math.max(speed, 1.1 * EARTH_ROTATION_RAD_S * bound.outer);
  }
  return Math.min(speed, bound.speed);
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
    if (scene.mode !== SceneMode.SCENE3D || !(frustum instanceof PerspectiveFrustum) || frustum.fov === undefined) {
      return this.#limits.floor;
    }
    const pixelsPerRadian = maxPixelsPerRadian(scene.drawingBufferWidth, scene.drawingBufferHeight, frustum.fov);
    // Simulation seconds until the next bound and through the render after it.
    const horizon = (RECOMPUTE_MS / 1000) * Math.abs(this.#sources.multiplier()) + this.#limits.ceiling;
    const components = this.#sources.components();
    if (!components.every((name) => PACED_COMPONENTS.has(name))) {
      return this.#limits.floor;
    }
    const orbitLine = components.includes("Orbit");
    const trackLine = components.includes("Orbit track");
    const lines = orbitLine || trackLine;
    const groundTracks = components.includes("Ground track");
    const cone = components.includes("Sensor cone");
    const models = components.includes("3D model");
    const cameraPosition = camera.positionWC;
    const cameraRadius = Cartesian3.magnitude(cameraPosition);

    let rate = 0;
    // Lines whose shells bound the rate more than their satellites do, to be measured where they
    // are drawn: the PLACED_LINES that bound it most, the least first.
    const toPlace: { shell: number; satellite: PacedSatellite; speed: number }[] = [];
    for (const satellite of this.#sources.satellites()) {
      // Cesium loads a model only on rendered frames.
      if (models && satellite.model?.pending) {
        return this.#limits.floor;
      }
      const position = satellite.props.trajectory.entityPosition?.getValue(time, this.#position);
      if (!position) {
        continue;
      }
      const bound = this.#orbitBound(satellite.props.orbit);
      const distance = Cartesian3.distance(cameraPosition, position);
      const own = angularRate(distance, bound.speed, horizon);
      rate = Math.max(rate, own);
      if (lines) {
        // A line's far points can pass closer than the satellite. It runs inside its samples by half a
        // chord and off them by the drift. A camera within an eccentric orbit's shell (Arktika-M's runs
        // 7,090 to 46,015 km) is measured to the line.
        const lineInner = bound.inner - bound.chord / 2 - LINE_DRIFT_METRES;
        const shell = angularRate(distanceToShell(cameraRadius, lineInner, bound.outer + LINE_DRIFT_METRES), bound.speed, horizon);
        if (shell > own) {
          if (toPlace.length === PLACED_LINES && shell <= toPlace[0]!.shell) {
            rate = Math.max(rate, shell);
          } else {
            const at = toPlace.findIndex((entry) => entry.shell > shell);
            toPlace.splice(at === -1 ? toPlace.length : at, 0, { shell, satellite, speed: lineSpeed(Cartesian3.magnitude(position), bound, orbitLine) });
            if (toPlace.length > PLACED_LINES) {
              rate = Math.max(rate, toPlace.shift()!.shell);
            }
          }
        }
      }
      if (groundTracks && satellite.components["Ground track"] !== undefined) {
        // The ribbon lies on the ground under the orbit, its clipped ends following the subpoint,
        // slower than the satellite.
        rate = Math.max(rate, angularRate(distanceToShell(cameraRadius, GROUND_RADIUS_METRES, bound.outer), bound.speed, horizon));
      }
      if (cone) {
        // Carried with the satellite and turned with its nadir, all within CONE_RADIUS_METERS of it.
        rate = Math.max(rate, angularRate(distance - CONE_RADIUS_METERS, bound.speed + bound.turnRate * CONE_RADIUS_METERS, horizon));
      }
      if (rate === Infinity) {
        return this.#limits.floor;
      }
    }
    for (const { shell, satellite, speed } of toPlace.toReversed()) {
      // None after this one can raise the rate.
      if (shell <= rate) {
        break;
      }
      const { trajectory } = satellite.props;
      const forEach = (visit: SampleVisitor) => trajectory.forEachSample(time, visit);
      const nearest = Math.min(
        (orbitLine ? lineDistance(forEach, cameraPosition, true) : undefined) ?? Infinity,
        (trackLine ? lineDistance(forEach, cameraPosition, false) : undefined) ?? Infinity,
      );
      // Without a sample, the shell stands.
      rate = Math.max(rate, Number.isFinite(nearest) ? Math.min(shell, angularRate(nearest, speed, horizon)) : shell);
    }
    return renderTimeChange(rate, pixelsPerRadian, this.#limits);
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
