// The camera path between the globe and the sky view, in three legs on one clock:
//
//   1. Lock on: the view swings onto the destination.
//   2. Descend: the destination stays at screen centre until the camera is overhead.
//   3. Rise: the camera lands while the view sweeps up from straight down to the aim.
//
// Underneath all three, the heading turns from the globe's to the aim's, about the
// observer's vertical.
//
// Blending the two end poses directly reaches empty sky within a few hundred
// milliseconds and hides the trip. Leaving plays the path backwards (see `SkyView`).

import { Cartesian3, Math as CesiumMath, Matrix3, Quaternion } from "@cesium/engine";

import { DeviceDetect } from "./util/DeviceDetect";
import { smootherstep } from "./util/easing";

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
   * changes no roll. Only its basis is read.
   */
  over: Pose;
  /**
   * In radians about the observer's vertical, from `over`'s heading to the one the
   * globe shows as up. Fixed for the flight: recomputed, a half turn could flip
   * sign as the ground height arrives.
   */
  turn: number;
  /** `from`'s attitude in the frame of the aim at the start, less `turn`: what the lock-on eases away. */
  swing: Quaternion;
}

/** Close to Cesium's own flight length; shorter and the descent and the rise blur together. */
export const FLIGHT_MS = 2200;

/** Lock-on ends early: it answers where the flight is going. */
export const LOCK_ON = 0.3;

/** The rise's share of the flight; it sweeps about 120°. */
export const TIP_UP = 0.45;

/** Touchdown comes before the rise ends: land, then look up. */
export const TOUCHDOWN = 0.8;

/**
 * Eased progress, clamped to [0, 1]; the clamp holds a leg at its ends. Every leg
 * starts and ends at zero rate, which hides the joins.
 */
export const easeFlight = (t: number): number => smootherstep(CesiumMath.clamp(t, 0, 1));

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
 * Along the great circle rather than through the planet. The camera is overhead
 * once `overhead` reaches 1 and down once `drop` does, so it comes to rest overhead
 * before landing instead of reaching the ground sideways.
 */
export function flightPosition(from: Cartesian3, to: Cartesian3, overhead: number, drop: number, result: Cartesian3): Cartesian3 {
  const fromRadius = Cartesian3.magnitude(from);
  const toRadius = Cartesian3.magnitude(to);
  if (fromRadius === 0 || toRadius === 0) {
    // The geocentre has no direction to rotate. Unreachable from a real camera.
    return Cartesian3.lerp(from, to, drop, result);
  }
  const height = fromRadius - toRadius;
  const left = heightLeft(height, drop);
  const radius = toRadius + left * height;
  // The way left round also shrinks with the height left, so the camera closes in
  // along the line of sight and the destination's angle off the vertical only
  // shrinks. Otherwise the geometric descent is low while still far off, and the
  // aim whips round to hold the destination (700°/s measured).
  const sweep = 1 - (1 - overhead) * left;
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

/**
 * The descent is geometric in the height, so the ground grows on screen at a
 * steady rate instead of rushing up at the end. Within about this many metres it
 * turns linear. Lower is steadier still (100: 13 e-folds/s at most above 100 m,
 * against 21 here and 54 with a lerp), but then the camera spends the rise
 * skimming ground the default base map has no detail for.
 */
const LANDING_METRES = 3000;

/** The fraction of `height` still to come down, in [0, 1], so never underground. */
function heightLeft(height: number, drop: number): number {
  if (height <= 0) {
    // Leaving for a globe camera lower than the eye: no zoom to pace.
    return 1 - drop;
  }
  return ((height + LANDING_METRES) ** (1 - drop) * LANDING_METRES ** drop - LANDING_METRES) / height;
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
const scratchVertical = new Cartesian3();
const scratchOverRotation = new Quaternion();
const scratchYaw = new Quaternion();
const scratchNadir = new Quaternion();
const scratchSight = new Quaternion();
const scratchAimed = new Quaternion();
const scratchSwing = new Quaternion();
const scratchFromRotation = new Quaternion();
const scratchToRotation = new Quaternion();
const scratchLocked = new Quaternion();
const scratchBlended = new Quaternion();
const scratchBasis = new Matrix3();

/**
 * The world-space turn that swings `down` onto the line of sight from `eye` to
 * `target`. Not a look-at cross product, which has no answer directly overhead,
 * where this flight ends: there it is the identity.
 */
function sightTurn(down: Cartesian3, target: Cartesian3, eye: Cartesian3, result: Quaternion): Quaternion {
  const line = Cartesian3.subtract(target, eye, scratchLine);
  const distance = Cartesian3.magnitude(line);
  if (distance < ARRIVED_METRES) {
    return Quaternion.clone(Quaternion.IDENTITY, result);
  }
  Cartesian3.divideByScalar(line, distance, line);

  const angle = Cartesian3.angleBetween(down, line);
  if (angle < CesiumMath.EPSILON7) {
    return Quaternion.clone(Quaternion.IDENTITY, result);
  }
  return Quaternion.fromAxisAngle(turnAxis(down, line, scratchAimAxis), angle, result);
}

/**
 * `to` and `over` must already describe the destination. The start's offset from
 * the aim splits into a twist about the view axis, which is straight down at the
 * aim, so a turn about the vertical, and the swing left over. Without the split,
 * an aim facing the equator from the northern hemisphere rolled the view 180° in
 * the lock-on's 0.66 s.
 */
export function flightPath(from: Pose, to: Pose, over: Pose): FlightPath {
  const aimed = Quaternion.multiply(sightTurn(over.direction, to.position, from.position, scratchSight), poseRotation(over, scratchOverRotation), scratchAimed);
  const offset = Quaternion.multiply(Quaternion.conjugate(aimed, aimed), poseRotation(from, scratchFromRotation), new Quaternion());
  // The short way round: `offset` and its negation are the same rotation.
  const sign = offset.w < 0 ? -1 : 1;
  const turn = 2 * Math.atan2(sign * offset.z, sign * offset.w);
  const twist = Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, turn, scratchYaw);
  return { from, to, over, turn, swing: Quaternion.multiply(Quaternion.conjugate(twist, twist), offset, offset) };
}

/**
 * `t` is raw progress, unclamped and uneased: each leg schedules itself off it. `result`
 * must not be a member of `path`.
 */
export function flightPose(path: FlightPath, t: number, result: Pose): Pose {
  const { from, to, over, turn, swing } = path;

  // The camera is overhead exactly when the rise starts, so the aim is already
  // straight down and the rise changes no roll.
  const overhead = easeFlight(t / (1 - TIP_UP));
  const arrival = easeFlight(t / TOUCHDOWN);
  flightPosition(from.position, to.position, overhead, arrival, result.position);
  result.fovy = CesiumMath.lerp(from.fovy, to.fovy, arrival);

  // The heading still to turn, about the vertical in world space so it never tilts
  // the horizon. Spread over the whole flight, the slowest a half turn can go.
  const vertical = Cartesian3.negate(over.direction, scratchVertical);
  const yaw = Quaternion.fromAxisAngle(vertical, turn * (1 - easeFlight(t)), scratchYaw);
  const nadir = Quaternion.multiply(yaw, poseRotation(over, scratchOverRotation), scratchNadir);

  // The swing ends long before the rise starts, so the aim alone holds the
  // destination at screen centre during the descent.
  const aimed = Quaternion.multiply(sightTurn(over.direction, to.position, result.position, scratchSight), nadir, scratchAimed);

  // Eased in the camera's own frame, so the destination's place on screen depends on
  // the lock-on alone. Blending towards the moving aim overshot it by 6° as the
  // camera swept round.
  const locked = Quaternion.multiply(aimed, Quaternion.slerp(swing, Quaternion.IDENTITY, easeFlight(t / LOCK_ON), scratchSwing), scratchLocked);
  const arriving = Quaternion.multiply(yaw, poseRotation(to, scratchToRotation), scratchToRotation);
  const blended = Quaternion.slerp(locked, arriving, easeFlight((t - (1 - TIP_UP)) / TIP_UP), scratchBlended);

  // slerp falls back to lerp for nearly equal rotations, which shortens the
  // quaternion, and `fromQuaternion` wants a unit one.
  Matrix3.fromQuaternion(Quaternion.normalize(blended, blended), scratchBasis);
  Matrix3.getColumn(scratchBasis, 0, result.right);
  Matrix3.getColumn(scratchBasis, 1, result.up);
  Matrix3.getColumn(scratchBasis, 2, result.direction);
  Cartesian3.negate(result.direction, result.direction);
  return result;
}
