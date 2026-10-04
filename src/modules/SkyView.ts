// The sky view: the app's own camera, parked on the ground at the observer and
// aimed upward, so the satellites the globe already draws are seen from below.
//
// This module owns the camera and nothing else. It takes an observer and an aim
// and produces a camera basis; resolving who the observer is, and stopping the
// other things that want to drive the camera, belong to the caller
// (src/modules/sceneSync.ts). Rationale: docs/adr/0003-sky-view.md.
//
// Entering and leaving are flights rather than cuts, which is why the pose the
// camera is given each frame is not always the pose the aim asks for — see
// `#apply`, and src/modules/skyFlight.ts for the interpolation itself.
//
// Two Cesium behaviours shape the implementation:
//
//   - `camera.setView` cannot express this. It converts direction/up back into
//     heading/pitch/roll, and `getHeading` switches formula within EPSILON3 of
//     straight up — above about 87.4° of elevation the roll comes back wrong by
//     up to 180°, which mirrors the whole sky. So the basis is assigned
//     directly and Cesium is kept out of Euler angles entirely. The same
//     applies to `camera.flyTo`, which is why the flight is ours.
//   - `ScreenSpaceCameraController` runs its collision detection *outside* the
//     `enableInputs` check, so clearing that flag alone still leaves
//     `adjustHeightForTerrain` free to lift the camera off the observer on any
//     frame it thinks it moved. Both flags come off.

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

/**
 * How far the eye may be above the ground under the observer.
 *
 * The floor is standing height, so the view cannot be walked under the surface
 * it is standing on. The ceiling is where "looking up from a point on the
 * ground" stops being a fair description of what is on screen: 5 km clears every
 * building and most of the relief anyone stands on — the ground height carries
 * the mountain itself — while still leaving the observer inside the weather.
 */
export const MIN_EYE_HEIGHT = 2;
export const MAX_EYE_HEIGHT = 5000;

/**
 * How often the ground under a walking observer is measured. Five metres of
 * base-speed walking, forty at a sprint — closer than terrain relief changes
 * over, and far cheaper than the per-frame request the honest answer would be.
 */
const WALK_MEASURE_MS = 250;

/**
 * The range a ground elevation can credibly fall in — roughly the Dead Sea shore
 * to rather above Everest, with room to spare at both ends.
 */
const MIN_GROUND_HEIGHT = -500;
const MAX_GROUND_HEIGHT = 9000;

/**
 * Whether a surface height can be believed, wherever it came from.
 *
 * It has to be asked of `globe.getHeight`, because the honest answer for "no tile
 * loaded here" is not `undefined`: with the default `EllipsoidTerrainProvider`,
 * where the surface is the ellipsoid and the answer is exactly 0, it has been
 * observed returning -36990. Taking that at face value puts the camera 37 km
 * underground, which stops the tiles under the observer from rendering at all,
 * which keeps the answer garbage — the view never recovers on its own.
 *
 * It is worth asking of a surface model's clamp too, for a different reason: that
 * clamps to whatever scene geometry is above the point, and a satellite's own 3D
 * model passing overhead is scene geometry.
 */
export const isPlausibleGroundHeight = (height: number | undefined): height is number =>
  height !== undefined && Number.isFinite(height) && height >= MIN_GROUND_HEIGHT && height <= MAX_GROUND_HEIGHT;

/**
 * Where the ground under the observer comes from when the globe cannot say.
 *
 * The globe is the default and needs no source: `getHeight` answers from tiles
 * that are already loaded, every frame, for free. A surface model is neither —
 * measuring it is a request, and with the photorealistic mesh the globe is not
 * even being drawn, so `getHeight` has nothing to answer from and the eye would
 * sit at ellipsoid height, hundreds of metres inside the mesh.
 *
 * Async, and asked once per observer rather than per frame: the answer needs the
 * tiles at that spot loaded, which is a network round trip, and standing still is
 * what the sky view does.
 */
export type GroundHeightSource = (observer: Observer) => Promise<number | undefined>;

/**
 * The labels the terrain should hide. A function, because the collection only
 * exists once the first label does.
 */
export type LabelSource = () => LabelCollection | undefined;

/**
 * Defaults chosen so the first frame is legible rather than empty sky. The
 * horizon is on screen because `pitch < fovy / 2`; that invariant is the whole
 * guarantee, which is why there is no per-orientation arithmetic here.
 */
export const DEFAULT_FOVY = 75;
export const DEFAULT_PITCH = 30;

/**
 * How far the view may zoom, stated as vertical field of view.
 *
 * 10° at the narrow end is roughly 7.5x magnification, which is what it takes to
 * separate two satellites sharing the reticle at the default zoom; below about 5°
 * hand tremor under device aiming dominates and it stops being precision. 100° at
 * the wide end is as much sky as the perspective will take — on a 21:9 window it
 * derives a horizontal `fov` of 141°, and the stretching at the edges is already
 * severe there.
 *
 * Note this deliberately lets the user break `pitch < fovy/2`, which is a
 * statement about the defaults on entry and not a standing invariant — zooming in
 * on something high up is *supposed* to take the horizon off screen.
 */
export const MIN_FOVY = 10;
export const MAX_FOVY = 100;

/** North is the emptiest direction to open on: passes culminate toward the equator. */
export const defaultAzimuth = (observer: Observer): number => (observer.lat >= 0 ? 180 : 0);

/**
 * The camera basis for an aim, in east-north-up components.
 *
 * Exported because this is the part worth testing: `up` and `right` are derived
 * from the aim angles rather than from a cross product against world up, so
 * there is no singularity at the zenith and no discontinuity crossing it.
 */
export function skyBasis(aim: Aim): Basis {
  return { direction: enuDirection(aim.azimuth, aim.pitch), ...rollBasis(aim.azimuth, aim.pitch, aim.roll) };
}

/**
 * The horizontal angle the view actually spans, at any aspect ratio.
 *
 * Distinct from `fovFromFovy` below, which answers the narrower question of what
 * to hand Cesium: on a portrait viewport Cesium's `fov` *is* the vertical angle,
 * so it is not the horizontal span and cannot be used as one.
 */
export function fovxFromFovy(fovyRadians: number, aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return fovyRadians;
  }
  return 2 * Math.atan(Math.tan(fovyRadians * 0.5) * aspectRatio);
}

/**
 * Cesium's `fov` is the horizontal angle on a landscape viewport and the
 * vertical one otherwise, so it means different things on a phone held two
 * ways. Everything here is specified vertically; this converts.
 */
export function fovFromFovy(fovyRadians: number, aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 1) {
    return fovyRadians;
  }
  return fovxFromFovy(fovyRadians, aspectRatio);
}

/**
 * The vertical angle behind a Cesium `fov`, and the exact inverse of
 * `fovFromFovy`. Needed on the way in: a flight starts at whatever the globe
 * camera's frustum was set to, and the flight interpolates vertical angles.
 */
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

/**
 * Where the view is between the globe and the ground.
 *
 * `active` covers all three of the non-off states, because the sky view owns the
 * camera for the whole of them. `settled` is the narrower question the HUD and
 * the crosshair have to ask instead: is the camera where the aim says it is, or
 * is it still on its way there?
 */
type Phase = "off" | "entering" | "live" | "leaving";

interface Flight {
  /**
   * The globe end, the sky end and the straight-down attitude between them. The
   * same three objects for as long as the view is up: the sky end and the
   * attitude are rewritten under the flight each frame, because the ground under
   * the observer is only known once its tiles are in and the aim can still move
   * while the camera is on its way.
   */
  path: FlightPath;
  /** Leaving is the flight in played backwards, so it is one path and a sign. */
  reverse: boolean;
  startedAt: number;
  durationMs: number;
  finished: Promise<void>;
  /** Resolves `finished`, on landing or on another flight taking over. */
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

  // Present exactly while the view is active, and the record of what has to be
  // put back. Restoring only what was actually changed is what lets the sky
  // view coexist with `?bg=false`, which has already destroyed the sky objects
  // a blanket restore would try to bring back.
  #saved: SavedState | undefined;

  // The pose the aim asks for, the same pose tipped all the way down, and the
  // pose actually given to the camera. Separate objects because during a flight
  // all three differ; the first two are the flight's destination and the
  // attitude it aims with, rewritten in place each frame so the descent keeps
  // re-aiming at ground that only shows up as tiles load.
  #sky: Pose = newPose();

  #over: Pose = newPose();

  #blended: Pose = newPose();

  #observer: Observer | undefined;

  // The observer's coordinates, kept in the form `globe.getHeight` wants so the
  // per-frame ground lookup allocates nothing.
  #observerCartographic = new Cartographic();

  // Sea level until a tile says otherwise, which is the exact answer for the
  // default terrain provider and a safe one for every other.
  #groundHeight = 0;

  // A surface model's answer, once it has one, and the flag that stops the globe
  // being consulted as well. Both matter: with OSM Buildings the globe is still
  // there and still has an opinion, and the two would fight every frame.
  #groundSource: GroundHeightSource | undefined;

  #groundMeasured = false;

  /** Which observer the outstanding measurement is about. */
  #groundGeneration = 0;

  /** When the ground was last asked about, for the walk's throttle. */
  #measuredAt = Number.NEGATIVE_INFINITY;

  #aim: Aim = { azimuth: 0, pitch: DEFAULT_PITCH, roll: 0 };

  #eyeHeight: number = MIN_EYE_HEIGHT;

  #fovy: number = DEFAULT_FOVY;

  // Rebuilt only when the observer or the ground under it moves, which is rare;
  // everything that reads it wants it every frame.
  #frame: ObserverFrame | undefined;

  #removePreRender: (() => void) | undefined;

  #labels: LabelSource | undefined;

  /** Each label collection taken while the view is up, with the distance to put back. */
  #borrowedLabels = new Map<LabelCollection, number>();

  constructor(scene: Scene, labels?: LabelSource) {
    this.#scene = scene;
    this.#labels = labels;
  }

  /** Whether the sky view owns the camera — true throughout both flights. */
  get active(): boolean {
    return this.#phase !== "off";
  }

  /**
   * Whether the camera has arrived. Anything that reads the aim to say something
   * about the picture — the HUD's tapes, the crosshair — has to wait for this:
   * during a flight the aim is the destination, not where the camera is looking.
   */
  get settled(): boolean {
    return this.#phase === "live";
  }

  get observer(): Observer | undefined {
    return this.#observer;
  }

  get aim(): Readonly<Aim> {
    return this.#aim;
  }

  /** The observer's local frame, for anything measuring angles against it. */
  get frame(): ObserverFrame | undefined {
    return this.#frame;
  }

  get fovy(): number {
    return this.#fovy;
  }

  /** Clamped here rather than at each caller: it is a property of the view. */
  set fovy(degrees: number) {
    this.#fovy = CesiumMath.clamp(degrees, MIN_FOVY, MAX_FOVY);
    this.#apply();
  }

  /** How far the eye is above the ground under the observer, in metres. */
  get eyeHeight(): number {
    return this.#eyeHeight;
  }

  /**
   * Lift the eye off the ground, or set it back down. Clamped here rather than
   * at the caller, for the same reason `fovy` is: it is a property of the view.
   */
  set eyeHeight(metres: number) {
    const height = CesiumMath.clamp(metres, MIN_EYE_HEIGHT, MAX_EYE_HEIGHT);
    if (height === this.#eyeHeight) {
      return;
    }
    this.#eyeHeight = height;
    // The frame is built at eye level, and every angle the HUD and the crosshair
    // measure is taken against it, so rising is a new frame rather than the same
    // one moved.
    this.#frame = undefined;
    this.#apply();
  }

  /** Point somewhere else. Omitted angles keep their current value. */
  look(aim: Partial<Aim>): void {
    this.#aim = { ...this.#aim, ...aim };
    this.#apply();
  }

  /**
   * Walk the observer to a nearby point, measuring the ground as it goes.
   *
   * Distinct from `enter`, which is what a station drag or an arriving fix goes
   * through: those are one move each and can afford a measurement outright. This
   * one runs every frame for as long as a key is held, so the measurement is
   * throttled — and throttled is the whole design, because neither alternative
   * works. Per frame is a request per frame. Not at all leaves the eye at the
   * height of wherever the walk began, which is underground the moment it heads
   * uphill.
   *
   * What it must not do is fall back to `globe.getHeight` for the walk. That is
   * free and follows the terrain, which is why it is the fallback of last resort
   * in `#skyPose` — but it answers about the globe, and under a surface model the
   * globe is not what is being stood on. With the photorealistic mesh it is not
   * even drawn, and its ellipsoid answers 0 plausibly enough to pass the guard,
   * which drops the eye through the mesh (docs/manual-verification.md).
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

  /**
   * Take the ground under the observer from somewhere other than the globe, or
   * pass `undefined` to go back to the globe.
   *
   * Re-measures immediately, because this is called when the thing being stood on
   * has changed — a surface model appearing or going away — and the height already
   * in hand was about the old one.
   */
  setGroundHeightSource(source: GroundHeightSource | undefined): void {
    this.#groundSource = source;
    this.#measureGround();
  }

  /**
   * Ask again what the observer is standing on.
   *
   * Either because it changed under them — a terrain swapped, a surface model
   * arriving or going away — or because they walked off it: `moveObserver`
   * measures on a throttle, and the walk ends with the one measurement that is
   * not on it.
   */
  remeasureGround(): void {
    this.#measureGround();
  }

  /**
   * Stand on a height somebody else measured, now.
   *
   * For the one case an asynchronous source cannot cover: the terrain under the
   * observer is being *replaced*, and the height has to change in the same breath as
   * the ground does. Left to arrive on its own it lands a beat late, and for that
   * beat the eye is under the new surface — 570 m under it in Munich, switching from
   * the ellipsoid to World Terrain — which does not read as a lag. It reads as the
   * world flipping inside out.
   */
  setGroundHeight(height: number): void {
    if (!isPlausibleGroundHeight(height)) {
      return;
    }
    // Counted as a measurement so the per-frame globe reads stay out of it: those
    // are what turn one honest move into a stagger of them as tiles refine.
    this.#groundGeneration += 1;
    this.#groundMeasured = true;
    if (height !== this.#groundHeight) {
      this.#groundHeight = height;
      this.#frame = undefined;
    }
    this.#apply();
    this.#scene.requestRender();
  }

  /**
   * Stand at the observer and look up, arriving by flight rather than by cut.
   *
   * The promise resolves when the camera has landed, or when another flight
   * takes over from this one. That is what lets the caller hold the interaction
   * back until the aim and the picture agree — see src/modules/sceneSync.ts.
   */
  enter(observer: Observer): Promise<void> {
    if (this.#phase === "entering" || this.#phase === "live") {
      // Re-entering with a different observer is a move, not a second entry: the
      // saved globe state is the one from the original entry, and a move that
      // flew would turn dragging a ground station marker into a slideshow.
      this.#setObserver(observer);
      this.#apply();
      return this.#flight?.finished ?? Promise.resolve();
    }

    if (this.#phase === "leaving") {
      // Turned around rather than started afresh: the camera is mid-air, and
      // `#saved` is still the globe this flight was on its way back to.
      this.#reset(observer);
      const arrival = this.#fly("entering");
      this.#apply();
      return arrival;
    }

    // The sky view is 3D, so entering from 2D or Columbus has to morph first —
    // instantly, because the camera is about to be assigned outright and an
    // animated morph would spend two seconds fighting it. Without this the basis
    // lands in an orthographic projection where it means nothing, and the frustum
    // is not a PerspectiveFrustum so there is no `fov` to save or to put back.
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

    // A leftover reference frame — from `jumpTo`, or from tracking — would
    // reinterpret every vector assigned below.
    camera.lookAtTransform(Matrix4.IDENTITY);
    // A tracking flight would land after this one and take the camera back.
    camera.cancelFlight();
    // Off for the flight as well as for the view: the descent is not something
    // to wrestle with, and collision detection would fight it all the way down.
    controller.enableInputs = false;
    controller.enableCollisionDetection = false;
    // The camera is driven from outside Cesium's own input handling, so there
    // is nothing for request-render mode to notice.
    this.#scene.requestRenderMode = false;
    // Let the ground hide what is behind it. Cesium's default clears the globe's
    // depth and occludes against an ellipsoid quad, which carries no relief.
    globe.depthTestAgainstTerrain = true;

    const arrival = this.#fly("entering");
    // Re-asserted every frame rather than set once: the ground height under the
    // observer is only known after a render, the viewport aspect can change at
    // any time, and anything else that grabs the camera loses on the next frame.
    this.#removePreRender = this.#scene.preRender.addEventListener(() => this.#apply());
    this.#apply();
    return arrival;
  }

  /**
   * Fly back to the globe the camera was taken from, and hand it back.
   *
   * The promise resolves once the globe state is restored — the caller must wait
   * for it before morphing the projection or releasing the camera mode, because
   * until then this view is still flying the camera.
   */
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
    // A different place has a different ground under it, and a different frame — but
    // the height it had is kept until the new one is measured, rather than reset to
    // sea level. Resetting looks harmless and is not: the observer moves while the
    // view is up (dragging a station, or a geolocation fix arriving), and anywhere
    // above sea level the eye would spend the measurement underneath the ground.
    // From under a surface you see its underside, textured with the same imagery,
    // which does not read as a wrong height. It reads as the world inverted.
    this.#frame = undefined;
    this.#measureGround();
  }

  /**
   * Ask the ground height source about the observer, if there is one.
   *
   * The generation is what makes a late answer harmless: the observer can move —
   * dragging a ground station does exactly that — while a measurement is in
   * flight, and that answer is about a place the view has left.
   */
  #measureGround(): void {
    const generation = ++this.#groundGeneration;
    // Stamped here rather than at the walk's own call, so every measurement — the
    // walk's, the settle's, a terrain swap — counts against the walk's throttle.
    this.#measuredAt = performance.now();
    // `#groundMeasured` deliberately survives this. A height measured a moment ago,
    // even somewhere slightly else, beats what the globe can offer while tiles are
    // still arriving — which is a coarse approximation, then a better one, then a
    // better one, each of which would move the camera.
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
      // The camera may already be standing at the old height, and nothing else
      // will come along to move it: a settled sky view renders on demand.
      this.#apply();
      this.#scene.requestRender();
    });
  }

  /** Fly the one path, forwards to enter and backwards to leave. */
  #fly(phase: "entering" | "leaving"): Promise<void> {
    const previous = this.#flight;
    this.#phase = phase;

    const durationMs = flightDuration();
    if (durationMs <= 0) {
      // Reduced motion asked for the cut this replaced, so give exactly that
      // rather than a brisk version of the flight.
      this.#flight = undefined;
      previous?.finish();
      if (phase === "leaving") {
        this.#restore();
      } else {
        this.#phase = "live";
      }
      return Promise.resolve();
    }

    // Turning around resumes the progress already made rather than starting
    // over: the path is the one thing both directions share, so playing it the
    // other way from here is exactly retracing the trip, and the camera carries
    // on from where it is instead of snapping to an end it is nowhere near.
    const covered = previous ? CesiumMath.clamp((performance.now() - previous.startedAt) / previous.durationMs, 0, 1) : 1;
    const path: FlightPath = previous?.path ?? { from: this.#savedPose(), to: this.#sky, over: this.#over };
    this.#flight = beginFlight(path, phase === "leaving", durationMs, durationMs * (1 - covered));
    // After the new flight is in place: whoever was awaiting the old one checks
    // where things stand the moment this resolves.
    previous?.finish();
    return this.#flight.finished;
  }

  /** The globe pose to return to. Only ever called with `#saved` present. */
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

  /** Put the globe back exactly as it was found, and stop touching the camera. */
  #restore(): void {
    const saved = this.#saved;
    // Cesium's Event defers removals raised from inside a dispatch, so this is
    // safe even though the landing frame is itself a preRender callback.
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
    // The saved `fov` rather than the pose's vertical angle: this is the number
    // that was taken, and putting it back is not a question of aspect ratio.
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

  /** Where the camera is right now, as a flight endpoint. */
  #cameraPose(): Pose {
    const { camera } = this.#scene;
    const fov = (camera.frustum instanceof PerspectiveFrustum ? camera.frustum.fov : undefined) ?? Number.NaN;
    return {
      position: Cartesian3.clone(camera.position, new Cartesian3()),
      direction: Cartesian3.clone(camera.direction, new Cartesian3()),
      up: Cartesian3.clone(camera.up, new Cartesian3()),
      right: Cartesian3.clone(camera.right, new Cartesian3()),
      // A frustum with no `fov` gives the flight nothing to interpolate, so it
      // starts at the angle it will end on and only the pose moves.
      fovy: Number.isNaN(fov) ? this.#fovy : CesiumMath.toDegrees(fovyFromFov(fov, this.#aspectRatio())),
    };
  }

  /**
   * The pose the aim asks for, written into `#sky`, and the same aim tipped all
   * the way down, written into `#over`. Refreshes the ground and the frame.
   */
  #skyPose(observer: Observer): Pose {
    const pose = this.#sky;

    // Stand on the ground rather than on the ellipsoid, which is hundreds of
    // metres out in the mountains. The last believable answer is kept, so an
    // implausible one — which is how a missing tile reports itself — leaves the
    // camera where it was instead of dropping it through the surface.
    //
    // Skipped once a surface model has answered: that model is what is being
    // stood on, and the globe underneath it — still loaded and still opinionated
    // under OSM Buildings — would pull the eye back down to the street every frame.
    if (!this.#groundMeasured) {
      const measured = this.#scene.globe.getHeight(this.#observerCartographic);
      if (isPlausibleGroundHeight(measured) && measured !== this.#groundHeight) {
        this.#groundHeight = measured;
        this.#frame = undefined;
      }
    }
    Cartesian3.fromDegrees(observer.lon, observer.lat, this.#groundHeight + this.#eyeHeight, undefined, pose.position);
    // Built from where the observer stands, never from `camera.position`, which
    // during a flight is somewhere over the ocean on the way here.
    this.#frame ??= observerFrame(pose.position);

    const enu = Transforms.eastNorthUpToFixedFrame(pose.position, undefined, new Matrix4());
    const rotation = Matrix4.getMatrix3(enu, new Matrix3());
    this.#orient(rotation, this.#aim, pose);
    pose.fovy = this.#fovy;

    // Straight down at the observer's feet, on the same azimuth and roll — the
    // attitude the descent aims with and the one the rise starts from. Built
    // through `skyBasis` like every other attitude here rather than as some
    // convenient nadir, because that is what makes the rise a pitch sweep from
    // -90° and nothing else: no roll creeps in, and `skyBasis` is continuous
    // through straight down, so -90° is an aim like any other.
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

    // Computed even while leaving, and even though the camera is elsewhere: it
    // is what keeps `frame` answerable for as long as the view is active.
    const sky = this.#skyPose(observer);
    const flight = this.#flight;
    if (!flight) {
      this.#assign(sky);
      return;
    }

    const progress = (performance.now() - flight.startedAt) / flight.durationMs;
    // Leaving runs the same path from the far end, so the trip out retraces the
    // trip in exactly: look down at your feet, take off, and swing away.
    this.#assign(flightPose(flight.path, flight.reverse ? 1 - progress : progress, this.#blended));
    if (progress >= 1) {
      this.#land();
    }
  }

  /**
   * Let the terrain hide labels too. Beyond `coarseDepthTestDistance` (~636 km)
   * Cesium tests a label against the ellipsoid alone and draws it in front of
   * the globe, so `depthTestAgainstTerrain` hides a satellite's point behind a
   * ridge and not its name. Every satellite is that far from the ground.
   *
   * Checked every frame because labels switched on mid-view create the collection.
   */
  #borrowLabels(): void {
    const labels = this.#labels?.();
    if (labels && !this.#borrowedLabels.has(labels)) {
      this.#borrowedLabels.set(labels, labels.coarseDepthTestDistance);
      labels.coarseDepthTestDistance = Number.POSITIVE_INFINITY;
    }
  }
}
