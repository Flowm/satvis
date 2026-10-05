// The camera path between the globe and the sky view, in three legs on one clock:
//
//   1. Lock on: the view swings onto the destination.
//   2. Descend: the destination stays at screen centre until the camera is overhead.
//   3. Rise: the camera lands while the view sweeps up from straight down to the aim.
//
// Blending the two end poses directly reaches empty sky within a few hundred
// milliseconds and hides the trip. Leaving plays the path backwards (see `SkyView`).

import { Cartesian3, EasingFunction, Math as CesiumMath, Matrix3, Quaternion } from "@cesium/engine";

import { DeviceDetect } from "./util/DeviceDetect";

/** A camera pose in world coordinates, with the vertical angle it is seen through. */
export interface Pose {
  position: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
  right: Cartesian3;
  /** Vertical field of view in degrees, never Cesium's `fov`. */
  fovy: number;
}

/** Every field is overwritten before it is read. */
export const newPose = (): Pose => ({
  position: new Cartesian3(),
  direction: new Cartesian3(),
  up: new Cartesian3(),
  right: new Cartesian3(),
  fovy: 0,
});

export interface FlightPath {
  from: Pose;
  to: Pose;
  /**
   * At the observer, looking straight down: `to`'s aim at -90° pitch, so the rise
   * is a pure pitch sweep with no roll. Only its basis is read.
   */
  over: Pose;
}

/** Close to Cesium's own flight length; shorter and the descent and the rise blur together. */
export const FLIGHT_MS = 2200;

/** Lock-on ends this early in the flight, while the position has barely moved, so the swing reads as a pan. */
export const LOCK_ON = 0.3;

/** The rise's share of the flight; it sweeps about 120°. */
export const TIP_UP = 0.45;

/** Touchdown comes before the rise ends: land, then look up. */
export const TOUCHDOWN = 0.8;

/** Cesium's flight default. Every leg starts and ends at zero rate, which hides the joins. */
const EASING = EasingFunction.QUINTIC_IN_OUT;

/** Clamped, which is also how a leg is scheduled. */
export const easeFlight = (t: number): number => EASING(CesiumMath.clamp(t, 0, 1));

/** Zero under reduced motion: a cut, not a shorter flight. */
export const flightDuration = (): number => (DeviceDetect.prefersReducedMotion() ? 0 : FLIGHT_MS);

/** Closer than this, there is no line of sight left to aim along. */
const ARRIVED_METRES = 1;

const scratchFromUnit = new Cartesian3();
const scratchToUnit = new Cartesian3();
const scratchAxis = new Cartesian3();
const scratchRotation = new Matrix3();
const scratchQuaternion = new Quaternion();

/**
 * Along the great circle rather than through the planet. `sweep` is the fraction
 * round the circle and `drop` the fraction down, so the camera comes to rest
 * overhead before landing instead of reaching the ground sideways. Lerping the
 * radius keeps every point between the endpoints' radii, so never underground.
 */
export function flightPosition(from: Cartesian3, to: Cartesian3, sweep: number, drop: number, result: Cartesian3): Cartesian3 {
  const fromRadius = Cartesian3.magnitude(from);
  const toRadius = Cartesian3.magnitude(to);
  if (fromRadius === 0 || toRadius === 0) {
    // The geocentre has no direction to rotate. Unreachable from a real camera.
    return Cartesian3.lerp(from, to, drop, result);
  }
  const radius = CesiumMath.lerp(fromRadius, toRadius, drop);
  const fromUnit = Cartesian3.divideByScalar(from, fromRadius, scratchFromUnit);
  const toUnit = Cartesian3.divideByScalar(to, toRadius, scratchToUnit);

  // atan2-based, so accurate at both ends where acos is not.
  const angle = Cartesian3.angleBetween(fromUnit, toUnit);
  if (angle < CesiumMath.EPSILON7) {
    return Cartesian3.multiplyByScalar(fromUnit, radius, result);
  }
  const axis = turnAxis(fromUnit, toUnit, scratchAxis);

  Matrix3.fromQuaternion(Quaternion.fromAxisAngle(axis, angle * sweep, scratchQuaternion), scratchRotation);
  Matrix3.multiplyByVector(scratchRotation, fromUnit, result);
  return Cartesian3.multiplyByScalar(result, radius, result);
}

/** Antipodal inputs have no unique axis, so any perpendicular is used. */
function turnAxis(from: Cartesian3, to: Cartesian3, result: Cartesian3): Cartesian3 {
  Cartesian3.cross(from, to, result);
  if (Cartesian3.magnitudeSquared(result) < CesiumMath.EPSILON14) {
    Cartesian3.cross(from, Cartesian3.mostOrthogonalAxis(from, scratchToUnit), result);
  }
  return Cartesian3.normalize(result, result);
}

/**
 * Columns are right, up and backwards: a Cesium camera looks down its negative z.
 * Blending quaternions keeps every step a rotation; lerped unit vectors would shear.
 */
export function poseRotation(pose: Pick<Pose, "direction" | "up" | "right">, result: Quaternion): Quaternion {
  const { direction: d, up: u, right: r } = pose;
  // Matrix3's constructor is row-major.
  return Quaternion.fromRotationMatrix(new Matrix3(r.x, u.x, -d.x, r.y, u.y, -d.y, r.z, u.z, -d.z), result);
}

const scratchLine = new Cartesian3();
const scratchAimAxis = new Cartesian3();
const scratchOverRotation = new Quaternion();
const scratchTurn = new Quaternion();
const scratchAimed = new Quaternion();
const scratchFromRotation = new Quaternion();
const scratchToRotation = new Quaternion();
const scratchLocked = new Quaternion();
const scratchBlended = new Quaternion();
const scratchBasis = new Matrix3();

/**
 * The attitude that puts `target` at screen centre, seen from `eye`. Built by
 * turning `over` onto the line of sight, not by a look-at cross product, which has
 * no answer directly overhead, where this flight ends.
 */
function aimedRotation(over: Pose, target: Cartesian3, eye: Cartesian3, result: Quaternion): Quaternion {
  const nadir = poseRotation(over, scratchOverRotation);
  const line = Cartesian3.subtract(target, eye, scratchLine);
  const distance = Cartesian3.magnitude(line);
  if (distance < ARRIVED_METRES) {
    return Quaternion.clone(nadir, result);
  }
  Cartesian3.divideByScalar(line, distance, line);

  const angle = Cartesian3.angleBetween(over.direction, line);
  if (angle < CesiumMath.EPSILON7) {
    return Quaternion.clone(nadir, result);
  }
  const turn = Quaternion.fromAxisAngle(turnAxis(over.direction, line, scratchAimAxis), angle, scratchTurn);
  // `turn` second: the nadir attitude is applied first, then swung in world space.
  return Quaternion.multiply(turn, nadir, result);
}

/** `t` is raw progress, unclamped and uneased: each leg schedules itself off it. `result` must not be a member of `path`. */
export function flightPose(path: FlightPath, t: number, result: Pose): Pose {
  const { from, to, over } = path;

  // The camera is overhead exactly when the rise starts, so the aim is already
  // straight down and the rise changes only pitch.
  const overhead = easeFlight(t / (1 - TIP_UP));
  const arrival = easeFlight(t / TOUCHDOWN);
  flightPosition(from.position, to.position, overhead, arrival, result.position);
  result.fovy = CesiumMath.lerp(from.fovy, to.fovy, arrival);

  // The swing ends long before the rise starts, so the aim alone holds the
  // destination at screen centre during the descent.
  const aimed = aimedRotation(over, to.position, result.position, scratchAimed);
  const locked = Quaternion.slerp(poseRotation(from, scratchFromRotation), aimed, easeFlight(t / LOCK_ON), scratchLocked);
  const blended = Quaternion.slerp(locked, poseRotation(to, scratchToRotation), easeFlight((t - (1 - TIP_UP)) / TIP_UP), scratchBlended);

  // slerp falls back to lerp for nearly equal rotations, which shortens the
  // quaternion, and `fromQuaternion` wants a unit one.
  Matrix3.fromQuaternion(Quaternion.normalize(blended, blended), scratchBasis);
  Matrix3.getColumn(scratchBasis, 0, result.right);
  Matrix3.getColumn(scratchBasis, 1, result.up);
  Matrix3.getColumn(scratchBasis, 2, result.direction);
  Cartesian3.negate(result.direction, result.direction);
  return result;
}
