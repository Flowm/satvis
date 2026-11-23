// Where the camera watches a satellite's swath from (ADR 0023): the broadcast camera of an
// overpass replay, and the chase that tracking takes while the recorded swath is on.

import { Cartesian3, Ellipsoid, JulianDate, Math as CesiumMath, Matrix3, Quaternion } from "@cesium/core";
import { SceneMode } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type { GroundPoint } from "@/modules/util/cmrGranules";
import { smootherstep } from "@/modules/util/easing";

/** How a replay's camera watches the overpass: tracking the satellite takes the chase. */
export type ReplayCamera = "nadir" | "tracking" | "broadcast";

/** The replay bar's choices, first the default. */
export const REPLAY_CAMERAS: readonly { value: ReplayCamera; label: string; title: string; icon: string }[] = [
  { value: "nadir", label: "Nadir", title: "Straight down on the station, north up", icon: "lucide:locate-fixed" },
  { value: "tracking", label: "Tracking", title: "Tracking the satellite from behind, over the swath it records", icon: "lucide:satellite" },
  { value: "broadcast", label: "Broadcast", title: "From beyond the station, turning with the satellite", icon: "lucide:video" },
];

/** The globe's. */
const ellipsoid = Ellipsoid.WGS84;

/** A swath's width bounded to what a camera distance scales with, metres: Landsat's 185 km and VIIRS's 3,000 km. */
function swathScaleM(swathKm: number): number {
  return CesiumMath.clamp(swathKm, 600, 3000) * 1000;
}

/** The chase's angle below the horizontal, onto the ground under the satellite. */
const CHASE_PITCH = CesiumMath.toRadians(50);

/**
 * The most the satellite may sit above the chase's aim, radians: NOAA-20's 12°, inside the
 * 14° half of the field of view a 21:9 screen has up. Closer in, as the narrow swaths' range
 * once was, Landsat's sat 35° up, off the screen.
 */
const CHASE_MAX_TILT = CesiumMath.toRadians(12);

/**
 * The chase's distance from the ground under the satellite, metres: the swath's, or further
 * where the satellite would sit more than CHASE_MAX_TILT above the ground under it.
 */
function chaseRangeM(swathKm: number, altitudeM: number): number {
  const keepsSatelliteInView = altitudeM / (Math.sin(CHASE_PITCH) - Math.cos(CHASE_PITCH) * Math.tan(CHASE_PITCH - CHASE_MAX_TILT));
  return Math.max(0.8 * swathScaleM(swathKm) + 700_000, keepsSatelliteInView);
}

/**
 * The chase camera from the satellite, in EntityView's axes for a low orbit: along its motion,
 * the orbit's normal and up. Behind it and above, looking at the ground under it from CHASE_PITCH.
 */
export function chaseOffset(swathKm: number, altitudeM: number, result = new Cartesian3()): Cartesian3 {
  const range = chaseRangeM(swathKm, altitudeM);
  return Cartesian3.fromElements(-range * Math.cos(CHASE_PITCH), 0, range * Math.sin(CHASE_PITCH) - altitudeM, result);
}

/**
 * How far below the satellite the chase looks, radians: EntityView aims at the satellite,
 * which puts the swath behind it off the bottom of the screen; aimed at the ground under it,
 * the satellite sits up the screen and the swath fills the rest.
 */
export function chaseTilt(swathKm: number, altitudeM: number): number {
  const range = chaseRangeM(swathKm, altitudeM);
  return CHASE_PITCH - Math.atan2(range * Math.sin(CHASE_PITCH) - altitudeM, range * Math.cos(CHASE_PITCH));
}

/** What the broadcast camera follows. */
export interface BroadcastTarget {
  /** The satellite, Earth-fixed. */
  position: (time: JulianDate) => Cartesian3 | undefined;
  station: GroundPoint;
  swathKm: number;
}

/**
 * Seconds every replay camera takes to move in from where the camera was, so a switch either
 * way moves at one pace: between Cesium's flights, 3 s at these distances, and the 1.5 s the
 * broadcast swing first took.
 */
export const REPLAY_SWING_S = 2;

/** REPLAY_SWING_S in the milliseconds the swing counts. */
const SWING_MS = REPLAY_SWING_S * 1000;

/** The broadcast camera's height above the station, metres. */
const BROADCAST_HEIGHT_M = 1_800_000;

/** How far up from the ground under the satellite it aims, as a share of the satellite's height: the satellite and its fresh swath both in view. */
const AIM_HEIGHT_SHARE = 0.15;

/** A camera's turn from the world's axes: its right, up and back as columns. */
function orientation(direction: Cartesian3, up: Cartesian3): Quaternion {
  const right = Cartesian3.normalize(Cartesian3.cross(direction, up, new Cartesian3()), new Cartesian3());
  const level = Cartesian3.cross(right, direction, new Cartesian3());
  // prettier-ignore
  const rotation = new Matrix3(
    right.x, level.x, -direction.x,
    right.y, level.y, -direction.y,
    right.z, level.z, -direction.z,
  );
  return Quaternion.fromRotationMatrix(rotation);
}

/** The direction and up of a camera turned by `turn` (orientation). */
function axes(turn: Quaternion): { direction: Cartesian3; up: Cartesian3 } {
  const rotation = Matrix3.fromQuaternion(turn);
  const up = Matrix3.getColumn(rotation, 1, new Cartesian3());
  const direction = Cartesian3.negate(Matrix3.getColumn(rotation, 2, new Cartesian3()), new Cartesian3());
  return { direction, up };
}

/** The ground track under `position` at `time`: the ground point, its up, and the track's direction and starboard. */
function groundTrack(position: BroadcastTarget["position"], time: JulianDate) {
  const now = position(time);
  const later = position(JulianDate.addSeconds(time, 1, new JulianDate()));
  const ground = now && ellipsoid.scaleToGeodeticSurface(now, new Cartesian3());
  if (!now || !later || !ground) return undefined;
  const up = ellipsoid.geodeticSurfaceNormal(ground, new Cartesian3());
  const velocity = Cartesian3.subtract(later, now, new Cartesian3());
  // Held, not moving: the samples do not reach the clock yet.
  if (Cartesian3.magnitude(velocity) < 1) return undefined;
  const vertical = Cartesian3.multiplyByScalar(up, Cartesian3.dot(velocity, up), new Cartesian3());
  const forward = Cartesian3.normalize(Cartesian3.subtract(velocity, vertical, new Cartesian3()), new Cartesian3());
  const right = Cartesian3.normalize(Cartesian3.cross(forward, up, new Cartesian3()), new Cartesian3());
  return { ground, up, right, altitudeM: Cartesian3.distance(now, ground) };
}

/**
 * A camera held beyond the station on its side of the ground track, turning to keep the
 * satellite in view as it passes. Running until stopped, or until the user drags or zooms,
 * something is tracked, or the scene leaves 3D: the camera then stays where it is.
 */
export class BroadcastCamera {
  /** Whose camera it holds. */
  readonly #viewer: Viewer;

  /** Undoes what start set up, while it runs. */
  #stop: (() => void) | undefined;

  /** Holds nothing until started. */
  constructor(viewer: Viewer) {
    this.#viewer = viewer;
  }

  /** False where the satellite has no position at the clock, or the scene is not 3D. */
  start(target: BroadcastTarget, { swing }: { swing: boolean }): boolean {
    this.stop();
    const viewer = this.#viewer;
    const { camera, scene } = viewer;
    const track = scene.mode === SceneMode.SCENE3D ? groundTrack(target.position, viewer.clock.currentTime) : undefined;
    if (!track) return false;

    const station = Cartesian3.fromDegrees(target.station.longitude, target.station.latitude, 0);
    const stationUp = ellipsoid.geodeticSurfaceNormal(station, new Cartesian3());
    // Beyond the station, so it sits in the foreground with the track behind it.
    const side = Math.sign(Cartesian3.dot(Cartesian3.subtract(station, track.ground, new Cartesian3()), track.right)) || 1;
    const away = Cartesian3.multiplyByScalar(track.right, side * (swathScaleM(target.swathKm) / 2 + 900_000), new Cartesian3());
    const eye = Cartesian3.add(station, away, new Cartesian3());
    Cartesian3.add(eye, Cartesian3.multiplyByScalar(stationUp, BROADCAST_HEIGHT_M, new Cartesian3()), eye);
    const eyeUp = ellipsoid.geodeticSurfaceNormal(eye, new Cartesian3());

    camera.cancelFlight();
    const from = swing ? { position: Cartesian3.clone(camera.positionWC), orientation: orientation(camera.directionWC, camera.upWC), started: performance.now() } : undefined;

    const aim = () => {
      const now = groundTrack(target.position, viewer.clock.currentTime);
      if (!now || scene.mode !== SceneMode.SCENE3D) return;
      const at = Cartesian3.add(now.ground, Cartesian3.multiplyByScalar(now.up, now.altitudeM * AIM_HEIGHT_SHARE, new Cartesian3()), new Cartesian3());
      let position = eye;
      let direction = Cartesian3.normalize(Cartesian3.subtract(at, eye, new Cartesian3()), new Cartesian3());
      // Level: the eye's up, square to the direction.
      let up = Cartesian3.cross(Cartesian3.normalize(Cartesian3.cross(direction, eyeUp, new Cartesian3()), new Cartesian3()), direction, new Cartesian3());
      const progress = from && Math.min(1, (performance.now() - from.started) / SWING_MS);
      if (from && progress !== undefined && progress < 1) {
        // The whole turn at once: blending direction and up apart whips the roll round where they cross.
        const eased = smootherstep(progress);
        position = Cartesian3.lerp(from.position, eye, eased, new Cartesian3());
        const turned = Quaternion.slerp(from.orientation, orientation(direction, up), eased, new Quaternion());
        ({ direction, up } = axes(turned));
        // A paused clock draws no frames of its own.
        scene.requestRender();
      }
      camera.setView({ destination: position, orientation: { direction, up } });
    };

    // After the clock has moved, before the frame is drawn.
    const removeAim = scene.preRender.addEventListener(aim);
    const removeTracked = viewer.trackedEntityChanged.addEventListener(() => {
      if (viewer.trackedEntity) this.stop();
    });
    const removeMorph = scene.morphStart.addEventListener(() => this.stop());
    // A drag or a zoom takes the camera back; a click, to select, does not.
    const canvas = scene.canvas;
    const onPointerMove = (event: PointerEvent) => {
      if (event.buttons !== 0) this.stop();
    };
    const onWheel = () => this.stop();
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("wheel", onWheel, { passive: true });
    this.#stop = () => {
      removeAim();
      removeTracked();
      removeMorph();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("wheel", onWheel);
    };
    aim();
    scene.requestRender();
    return true;
  }

  /** Lets the camera go where it is; nothing where it is not running. */
  stop(): void {
    this.#stop?.();
    this.#stop = undefined;
  }
}
