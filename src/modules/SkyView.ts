// The sky view: the app's own camera, parked at the observer and aimed upward.
// It owns the camera only; the caller (src/modules/sceneSync.ts) resolves the
// observer and stops whatever else drives the camera. See docs/adr/0003-sky-view.md.
//
// Two Cesium quirks shape it:
// - `camera.setView` and `camera.flyTo` go through heading/pitch/roll, and
//   `getHeading` switches formula within EPSILON3 of straight up, so above ~87.4°
//   the roll comes back up to 180° wrong. The basis is assigned directly.
// - `ScreenSpaceCameraController` runs collision detection outside the
//   `enableInputs` check, so both flags must come off.

import { Cartesian3, Cartographic, Math as CesiumMath, type LabelCollection, Matrix3, Matrix4, PerspectiveFrustum, type Scene, SceneMode, Transforms } from "@cesium/engine";

import { flightDuration, type FlightPath, flightPose, newPose, type Pose } from "./skyFlight";
import { type Aim, enuDirection, type Observer, type ObserverFrame, observerFrame, rollBasis } from "./skyGeometry";

export type { Aim, Observer } from "./skyGeometry";

/** An orthonormal camera basis in east-north-up components. */
export interface Basis {
  direction: Cartesian3;
  up: Cartesian3;
  right: Cartesian3;
}

/** Eye height above the ground under the observer, in metres. */
export const MIN_EYE_HEIGHT = 2;
export const MAX_EYE_HEIGHT = 5000;

/** Ground measurement throttle while walking: 5 m at base speed, 40 m at a sprint. */
const WALK_MEASURE_MS = 250;

/** Plausible ground elevation in metres: below the Dead Sea to above Everest. */
const MIN_GROUND_HEIGHT = -500;
const MAX_GROUND_HEIGHT = 9000;

/**
 * `globe.getHeight` with no tile loaded can return garbage (-36990 observed on
 * the ellipsoid), which puts the camera so far underground that the tiles never
 * load. A surface model's clamp can also hit a satellite's 3D model overhead.
 */
export const isPlausibleGroundHeight = (height: number | undefined): height is number =>
  height !== undefined && Number.isFinite(height) && height >= MIN_GROUND_HEIGHT && height <= MAX_GROUND_HEIGHT;

/**
 * The ground under a surface model, which `globe.getHeight` cannot give: the
 * photorealistic mesh does not draw the globe. Asked once per observer rather
 * than per frame, because it is a network round trip.
 */
export type GroundHeightSource = (observer: Observer) => Promise<number | undefined>;

/** A function, because the collection exists only once the first label does. */
export type LabelSource = () => LabelCollection | undefined;

/** The horizon is on screen on entry because `DEFAULT_PITCH < DEFAULT_FOVY / 2`. */
export const DEFAULT_FOVY = 75;
export const DEFAULT_PITCH = 30;

/**
 * Vertical field of view limits, in degrees. 10° (~7.5x) separates two satellites
 * in the reticle; below ~5° hand tremor dominates under device aiming. 100° is a
 * 141° horizontal `fov` on 21:9. Zooming may break `pitch < fovy / 2` on purpose.
 */
export const MIN_FOVY = 10;
export const MAX_FOVY = 100;

/** North is the emptiest direction to open on: passes culminate toward the equator. */
export const defaultAzimuth = (observer: Observer): number => (observer.lat >= 0 ? 180 : 0);

/**
 * In east-north-up components. `up` and `right` come from the aim angles, not a
 * cross product with world up, so nothing is singular at the zenith.
 */
export function skyBasis(aim: Aim): Basis {
  return { direction: enuDirection(aim.azimuth, aim.pitch), ...rollBasis(aim.azimuth, aim.pitch, aim.roll) };
}

/** The horizontal span. Not `fovFromFovy`: on a portrait viewport Cesium's `fov` is vertical. */
export function fovxFromFovy(fovyRadians: number, aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return fovyRadians;
  }
  return 2 * Math.atan(Math.tan(fovyRadians * 0.5) * aspectRatio);
}

/** Cesium's `fov` is horizontal on a landscape viewport and vertical otherwise. */
export function fovFromFovy(fovyRadians: number, aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 1) {
    return fovyRadians;
  }
  return fovxFromFovy(fovyRadians, aspectRatio);
}

/** The inverse of `fovFromFovy`. */
export function fovyFromFov(fovRadians: number, aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 1) {
    return fovRadians;
  }
  return 2 * Math.atan(Math.tan(fovRadians * 0.5) / aspectRatio);
}

interface SavedState {
  pose: Pose;
  /** Cesium's own `fov`, put back verbatim; NaN when the frustum had none. */
  fov: number;
  requestRenderMode: boolean;
  enableInputs: boolean;
  enableCollisionDetection: boolean;
  depthTestAgainstTerrain: boolean;
}

type Phase = "off" | "entering" | "live" | "leaving";

interface Flight {
  /**
   * Shared by both directions. `to` and `over` are rewritten each frame, because
   * the ground height arrives with the tiles and the aim can move mid-flight.
   */
  path: FlightPath;
  /** Leaving plays the path backwards. */
  reverse: boolean;
  startedAt: number;
  durationMs: number;
  finished: Promise<void>;
  /** Called on landing, or when another flight takes over. */
  finish: () => void;
}

function beginFlight(path: FlightPath, reverse: boolean, durationMs: number, elapsedMs: number): Flight {
  let finish = (): void => {};
  const finished = new Promise<void>((resolve) => {
    finish = () => resolve();
  });
  return { path, reverse, startedAt: performance.now() - elapsedMs, durationMs, finished, finish };
}

export class SkyView {
  #scene: Scene;

  #phase: Phase = "off";

  #flight: Flight | undefined;

  /**
   * Present exactly while the view is active. It holds only what `enter` changed,
   * so a restore cannot revive the sky objects `?bg=false` destroyed.
   */
  #saved: SavedState | undefined;

  /**
   * The aimed pose, the same aim pitched to -90°, and the pose given to the
   * camera. They differ during a flight; the first two are rewritten each frame.
   */
  #sky: Pose = newPose();

  #over: Pose = newPose();

  #blended: Pose = newPose();

  #observer: Observer | undefined;

  /** In the form `globe.getHeight` wants, so the per-frame lookup allocates nothing. */
  #observerCartographic = new Cartographic();

  #groundHeight = 0;

  /**
   * Once a surface model answers, `#groundMeasured` stops the globe being read
   * too: under OSM Buildings the two would fight every frame.
   */
  #groundSource: GroundHeightSource | undefined;

  #groundMeasured = false;

  /** Invalidates a measurement in flight when the observer moves. */
  #groundGeneration = 0;

  #measuredAt = Number.NEGATIVE_INFINITY;

  #aim: Aim = { azimuth: 0, pitch: DEFAULT_PITCH, roll: 0 };

  #eyeHeight: number = MIN_EYE_HEIGHT;

  #fovy: number = DEFAULT_FOVY;

  /** Rebuilt lazily after the observer, the ground or the eye height changes. */
  #frame: ObserverFrame | undefined;

  #removePreRender: (() => void) | undefined;

  #labels: LabelSource | undefined;

  /** The `coarseDepthTestDistance` to put back on each borrowed collection. */
  #borrowedLabels = new Map<LabelCollection, number>();

  constructor(scene: Scene, labels?: LabelSource) {
    this.#scene = scene;
    this.#labels = labels;
  }

  /** True throughout both flights. */
  get active(): boolean {
    return this.#phase !== "off";
  }

  /** False during a flight, when the aim is the destination rather than where the camera looks. */
  get settled(): boolean {
    return this.#phase === "live";
  }

  get observer(): Observer | undefined {
    return this.#observer;
  }

  get aim(): Readonly<Aim> {
    return this.#aim;
  }

  get frame(): ObserverFrame | undefined {
    return this.#frame;
  }

  get fovy(): number {
    return this.#fovy;
  }

  set fovy(degrees: number) {
    this.#fovy = CesiumMath.clamp(degrees, MIN_FOVY, MAX_FOVY);
    this.#apply();
  }

  /** In metres above the ground under the observer. */
  get eyeHeight(): number {
    return this.#eyeHeight;
  }

  set eyeHeight(metres: number) {
    const height = CesiumMath.clamp(metres, MIN_EYE_HEIGHT, MAX_EYE_HEIGHT);
    if (height === this.#eyeHeight) {
      return;
    }
    this.#eyeHeight = height;
    // The frame is built at eye level.
    this.#frame = undefined;
    this.#apply();
  }

  /** Omitted angles keep their current value. */
  look(aim: Partial<Aim>): void {
    this.#aim = { ...this.#aim, ...aim };
    this.#apply();
  }

  /**
   * Walk the observer, measuring the ground on a throttle. Do not fall back to
   * `globe.getHeight` here: under a surface model the globe is not what is stood
   * on, and its ellipsoid answer of 0 passes the guard and drops the eye through
   * the mesh (docs/adr/0005-surface-models.md, the ground under the sky view).
   */
  moveObserver(observer: Observer): void {
    if (!this.#observer) {
      return;
    }
    this.#observer = observer;
    Cartographic.fromDegrees(observer.lon, observer.lat, 0, this.#observerCartographic);
    this.#frame = undefined;
    if (performance.now() - this.#measuredAt >= WALK_MEASURE_MS) {
      this.#measureGround();
    }
    this.#apply();
  }

  /** `undefined` returns to the globe. Re-measures at once: the height in hand was about the old surface. */
  setGroundHeightSource(source: GroundHeightSource | undefined): void {
    this.#groundSource = source;
    this.#measureGround();
  }

  /** For a terrain swap, or the end of a walk (`moveObserver` measures on a throttle). */
  remeasureGround(): void {
    this.#measureGround();
  }

  /**
   * Set the height synchronously while the terrain is replaced. An async
   * measurement lands a frame late, with the eye under the new surface (570 m in
   * Munich, ellipsoid to World Terrain), which renders the world inside out.
   */
  setGroundHeight(height: number): void {
    if (!isPlausibleGroundHeight(height)) {
      return;
    }
    // Counted as a measurement so the per-frame globe reads, which refine as tiles load, cannot override it.
    this.#groundGeneration += 1;
    this.#groundMeasured = true;
    if (height !== this.#groundHeight) {
      this.#groundHeight = height;
      this.#frame = undefined;
    }
    this.#apply();
    this.#scene.requestRender();
  }

  /** Resolves when the camera lands, or when another flight takes over (see src/modules/sceneSync.ts). */
  enter(observer: Observer): Promise<void> {
    if (this.#phase === "entering" || this.#phase === "live") {
      // A move, not a second entry: `#saved` is from the original entry, and
      // flying each move would turn a ground station drag into a slideshow.
      this.#setObserver(observer);
      this.#apply();
      return this.#flight?.finished ?? Promise.resolve();
    }

    if (this.#phase === "leaving") {
      // The camera is mid-air, and `#saved` is still the globe it was flying back to.
      this.#reset(observer);
      const arrival = this.#fly("entering");
      this.#apply();
      return arrival;
    }

    // The sky view needs a perspective frustum. Morph instantly: an animated morph
    // would fight the directly assigned camera for two seconds.
    if (this.#scene.mode !== SceneMode.SCENE3D) {
      this.#scene.morphTo3D(0);
    }

    const { camera, globe, screenSpaceCameraController: controller } = this.#scene;
    this.#saved = {
      pose: this.#cameraPose(),
      fov: (camera.frustum instanceof PerspectiveFrustum ? camera.frustum.fov : undefined) ?? Number.NaN,
      requestRenderMode: this.#scene.requestRenderMode,
      enableInputs: controller.enableInputs,
      enableCollisionDetection: controller.enableCollisionDetection,
      depthTestAgainstTerrain: globe.depthTestAgainstTerrain,
    };

    this.#reset(observer);

    // A leftover reference frame (from `jumpTo` or tracking) would reinterpret every vector below.
    camera.lookAtTransform(Matrix4.IDENTITY);
    // A tracking flight would land after this one and take the camera back.
    camera.cancelFlight();
    // Off during the flight too, or collision detection fights the descent.
    controller.enableInputs = false;
    controller.enableCollisionDetection = false;
    // The camera is driven outside Cesium's input handling, so request-render mode would not notice it.
    this.#scene.requestRenderMode = false;
    // Cesium's default occludes against an ellipsoid quad, which carries no relief.
    globe.depthTestAgainstTerrain = true;

    const arrival = this.#fly("entering");
    // Re-asserted every frame: the ground height is known only after a render, the
    // aspect can change, and anything else that grabs the camera loses.
    this.#removePreRender = this.#scene.preRender.addEventListener(() => this.#apply());
    this.#apply();
    return arrival;
  }

  /** Resolves once the globe state is restored. Wait for it before morphing or releasing the camera mode. */
  exit(): Promise<void> {
    if (this.#phase === "off") {
      return Promise.resolve();
    }
    if (this.#phase === "leaving") {
      return this.#flight?.finished ?? Promise.resolve();
    }
    if (!this.#saved) {
      // Unreachable: every non-off phase has a saved globe to go back to.
      this.#restore();
      return Promise.resolve();
    }
    return this.#fly("leaving");
  }

  #reset(observer: Observer): void {
    this.#setObserver(observer);
    this.#aim = { azimuth: defaultAzimuth(observer), pitch: DEFAULT_PITCH, roll: 0 };
    this.#eyeHeight = MIN_EYE_HEIGHT;
    this.#fovy = DEFAULT_FOVY;
  }

  #setObserver(observer: Observer): void {
    this.#observer = observer;
    Cartographic.fromDegrees(observer.lon, observer.lat, 0, this.#observerCartographic);
    // Keep the old ground height until the new one is measured. Resetting to sea
    // level puts the eye under the ground while the observer is dragged, and the
    // underside of the surface reads as the world inverted.
    this.#frame = undefined;
    this.#measureGround();
  }

  /** The generation discards an answer about a place the observer has left. */
  #measureGround(): void {
    const generation = ++this.#groundGeneration;
    // Stamped here so every measurement counts against the walk's throttle.
    this.#measuredAt = performance.now();
    // `#groundMeasured` survives: a recent height beats the globe's coarse-to-fine
    // answers while tiles load, each of which would move the camera.
    const source = this.#groundSource;
    const observer = this.#observer;
    if (!source || !observer) {
      return;
    }
    void source(observer).then((height) => {
      if (generation !== this.#groundGeneration || !isPlausibleGroundHeight(height)) {
        return;
      }
      this.#groundMeasured = true;
      if (height !== this.#groundHeight) {
        this.#groundHeight = height;
        this.#frame = undefined;
      }
      // A settled sky view renders on demand, so nothing else would move the camera.
      this.#apply();
      this.#scene.requestRender();
    });
  }

  #fly(phase: "entering" | "leaving"): Promise<void> {
    const previous = this.#flight;
    this.#phase = phase;

    const durationMs = flightDuration();
    if (durationMs <= 0) {
      // Reduced motion gets a cut, not a brisk flight.
      this.#flight = undefined;
      previous?.finish();
      if (phase === "leaving") {
        this.#restore();
      } else {
        this.#phase = "live";
      }
      return Promise.resolve();
    }

    // Turning around resumes the progress already made, so the camera retraces
    // the path from where it is.
    const covered = previous ? CesiumMath.clamp((performance.now() - previous.startedAt) / previous.durationMs, 0, 1) : 1;
    const path: FlightPath = previous?.path ?? { from: this.#savedPose(), to: this.#sky, over: this.#over };
    this.#flight = beginFlight(path, phase === "leaving", durationMs, durationMs * (1 - covered));
    // After the new flight is in place: whoever awaited the old one checks the
    // state as soon as it resolves.
    previous?.finish();
    return this.#flight.finished;
  }

  /** Only called with `#saved` present. */
  #savedPose(): Pose {
    return this.#saved?.pose ?? this.#cameraPose();
  }

  #land(): void {
    const flight = this.#flight;
    this.#flight = undefined;
    if (this.#phase === "leaving") {
      this.#restore();
    } else {
      this.#phase = "live";
    }
    flight?.finish();
  }

  #restore(): void {
    const saved = this.#saved;
    // Cesium's Event defers removals raised during a dispatch, so this is safe
    // inside the landing frame's preRender callback.
    this.#removePreRender?.();
    this.#removePreRender = undefined;
    this.#flight = undefined;
    this.#saved = undefined;
    this.#observer = undefined;
    this.#frame = undefined;
    this.#phase = "off";
    for (const [labels, distance] of this.#borrowedLabels) {
      if (!labels.isDestroyed()) {
        labels.coarseDepthTestDistance = distance;
      }
    }
    this.#borrowedLabels.clear();
    if (!saved) {
      return;
    }

    const { camera, screenSpaceCameraController: controller } = this.#scene;
    camera.lookAtTransform(Matrix4.IDENTITY);
    Cartesian3.clone(saved.pose.position, camera.position);
    Cartesian3.clone(saved.pose.direction, camera.direction);
    Cartesian3.clone(saved.pose.up, camera.up);
    Cartesian3.clone(saved.pose.right, camera.right);
    // The saved `fov` itself, so a changed aspect ratio cannot alter it.
    if (camera.frustum instanceof PerspectiveFrustum && !Number.isNaN(saved.fov)) {
      camera.frustum.fov = saved.fov;
    }
    controller.enableInputs = saved.enableInputs;
    controller.enableCollisionDetection = saved.enableCollisionDetection;
    this.#scene.requestRenderMode = saved.requestRenderMode;
    this.#scene.globe.depthTestAgainstTerrain = saved.depthTestAgainstTerrain;
  }

  #aspectRatio(): number {
    const { clientWidth, clientHeight } = this.#scene.canvas;
    return clientHeight > 0 ? clientWidth / clientHeight : 1;
  }

  #cameraPose(): Pose {
    const { camera } = this.#scene;
    const fov = (camera.frustum instanceof PerspectiveFrustum ? camera.frustum.fov : undefined) ?? Number.NaN;
    return {
      position: Cartesian3.clone(camera.position, new Cartesian3()),
      direction: Cartesian3.clone(camera.direction, new Cartesian3()),
      up: Cartesian3.clone(camera.up, new Cartesian3()),
      right: Cartesian3.clone(camera.right, new Cartesian3()),
      // With no `fov` to start from, the flight keeps the end angle and only the pose moves.
      fovy: Number.isNaN(fov) ? this.#fovy : CesiumMath.toDegrees(fovyFromFov(fov, this.#aspectRatio())),
    };
  }

  /** Writes the aimed pose into `#sky` and the same aim at -90° pitch into `#over`. */
  #skyPose(observer: Observer): Pose {
    const pose = this.#sky;

    // Stand on the ground, not the ellipsoid. An implausible height (a missing
    // tile) keeps the last one. Skipped once a surface model has answered, or the
    // globe under it (OSM Buildings) would pull the eye to the street each frame.
    if (!this.#groundMeasured) {
      const measured = this.#scene.globe.getHeight(this.#observerCartographic);
      if (isPlausibleGroundHeight(measured) && measured !== this.#groundHeight) {
        this.#groundHeight = measured;
        this.#frame = undefined;
      }
    }
    Cartesian3.fromDegrees(observer.lon, observer.lat, this.#groundHeight + this.#eyeHeight, undefined, pose.position);
    // From the observer, never `camera.position`, which is elsewhere mid-flight.
    this.#frame ??= observerFrame(pose.position);

    const enu = Transforms.eastNorthUpToFixedFrame(pose.position, undefined, new Matrix4());
    const rotation = Matrix4.getMatrix3(enu, new Matrix3());
    this.#orient(rotation, this.#aim, pose);
    pose.fovy = this.#fovy;

    // Straight down on the same azimuth and roll, through `skyBasis`, so the rise
    // is a pure pitch sweep from -90° with no roll creeping in.
    Cartesian3.clone(pose.position, this.#over.position);
    this.#orient(rotation, { ...this.#aim, pitch: -90 }, this.#over);
    return pose;
  }

  /** An east-north-up aim written into a pose, in world coordinates. */
  #orient(enuToFixed: Matrix3, aim: Aim, into: Pose): void {
    const { direction, up, right } = skyBasis(aim);
    Matrix3.multiplyByVector(enuToFixed, direction, into.direction);
    Matrix3.multiplyByVector(enuToFixed, up, into.up);
    Matrix3.multiplyByVector(enuToFixed, right, into.right);
  }

  #assign(pose: Pose): void {
    const { camera } = this.#scene;
    Cartesian3.clone(pose.position, camera.position);
    Cartesian3.clone(pose.direction, camera.direction);
    Cartesian3.clone(pose.up, camera.up);
    Cartesian3.clone(pose.right, camera.right);
    if (camera.frustum instanceof PerspectiveFrustum) {
      camera.frustum.fov = fovFromFovy(CesiumMath.toRadians(pose.fovy), this.#aspectRatio());
    }
  }

  #apply(): void {
    const observer = this.#observer;
    if (!observer || this.#phase === "off") {
      return;
    }
    this.#borrowLabels();

    // Computed even while leaving, so `frame` stays answerable while active.
    const sky = this.#skyPose(observer);
    const flight = this.#flight;
    if (!flight) {
      this.#assign(sky);
      return;
    }

    const progress = (performance.now() - flight.startedAt) / flight.durationMs;
    this.#assign(flightPose(flight.path, flight.reverse ? 1 - progress : progress, this.#blended));
    if (progress >= 1) {
      this.#land();
    }
  }

  /**
   * Beyond `coarseDepthTestDistance` (~636 km) Cesium tests labels against the
   * ellipsoid only, so terrain hides a satellite's point but not its name.
   * Checked every frame: switching labels on mid-view creates the collection.
   */
  #borrowLabels(): void {
    const labels = this.#labels?.();
    if (labels && !this.#borrowedLabels.has(labels)) {
      this.#borrowedLabels.set(labels, labels.coarseDepthTestDistance);
      labels.coarseDepthTestDistance = Number.POSITIVE_INFINITY;
    }
  }
}
