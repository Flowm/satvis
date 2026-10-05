// Turning a phone's orientation into an aim for the sky view.
//
// Verified on iOS: the screen-orientation sign and `360 - webkitCompassHeading`
// are right. Not verified on Android, where north comes from
// `deviceorientationabsolute` (see docs/adr/0004-compass-aiming.md). Needs a
// secure context, so test through a tunnel or a preview deploy, not `pnpm dev:host`.
//
// The device frame is `deviceorientation`'s: flat, screen up, top edge north, its
// X/Y/Z are east/north/up, so alpha = beta = gamma = 0 is the identity.

import { Cartesian3, Math as CesiumMath, Matrix3 } from "@cesium/engine";

import { type Aim, normalizeAzimuth, rollOf } from "./skyGeometry";

export { normalizeAzimuth } from "./skyGeometry";

export interface DeviceOrientationSample {
  /** Degrees about the vertical, 0-360. Relative to an arbitrary zero on iOS. */
  alpha: number;
  /** Degrees front to back, -180 to 180. */
  beta: number;
  /** Degrees left to right, -90 to 90. */
  gamma: number;
  /** `screen.orientation.angle`: the content's rotation from natural. */
  screenAngle: number;
}

/**
 * Degrees from flat within which iOS's compass heading holds. `360 - webkitCompassHeading`
 * is valid only flat; pointed near the zenith it swings ~180° and spins the sky.
 */
const COMPASS_POSTURE_TOLERANCE = 35;

const BACK_CAMERA: Cartesian3 = new Cartesian3(0, 0, -1);
const SCREEN_UP: Cartesian3 = new Cartesian3(0, 1, 0);
const SCREEN_NORMAL: Cartesian3 = new Cartesian3(0, 0, 1);

/**
 * Device frame into east-north-up. Intrinsic Z-X'-Y'', as `deviceorientation`
 * specifies; the screen rotation comes last because it turns the display, not the hardware.
 */
function deviceRotation({ alpha, beta, gamma, screenAngle }: DeviceOrientationSample): Matrix3 {
  const rotation = Matrix3.multiply(
    Matrix3.multiply(Matrix3.fromRotationZ(CesiumMath.toRadians(alpha)), Matrix3.fromRotationX(CesiumMath.toRadians(beta)), new Matrix3()),
    Matrix3.fromRotationY(CesiumMath.toRadians(gamma)),
    new Matrix3(),
  );
  return Matrix3.multiply(rotation, Matrix3.fromRotationZ(CesiumMath.toRadians(-screenAngle)), rotation);
}

/** Before compass correction: the azimuth is measured from `alpha`'s zero, which drifts on iOS. */
export function aimFromDeviceOrientation(sample: DeviceOrientationSample): Aim {
  const rotation = deviceRotation(sample);
  // The rear camera looks along -Z; the top of the display is +Y.
  const direction = Matrix3.multiplyByVector(rotation, BACK_CAMERA, new Cartesian3());
  const screenUp = Matrix3.multiplyByVector(rotation, SCREEN_UP, new Cartesian3());

  const pitch = CesiumMath.toDegrees(Math.asin(CesiumMath.clamp(direction.z, -1, 1)));
  const azimuth = normalizeAzimuth(CesiumMath.toDegrees(Math.atan2(direction.x, direction.y)));
  // Decomposed against the same level pair `skyBasis` composes with, which stays
  // defined with the phone pointed straight up, unlike an Euler angle.
  return { azimuth, pitch, roll: rollOf(azimuth, pitch, screenUp) };
}

export function compassIsMeaningful(sample: DeviceOrientationSample): boolean {
  // Flat means the screen normal (+Z) is near vertical, face up or down. The
  // screen angle cannot change that.
  const rotation = deviceRotation({ ...sample, screenAngle: 0 });
  const screenNormal = Matrix3.multiplyByVector(rotation, SCREEN_NORMAL, new Cartesian3());
  const tiltFromHorizontal = CesiumMath.toDegrees(Math.acos(CesiumMath.clamp(Math.abs(screenNormal.z), -1, 1)));
  return tiltFromHorizontal <= COMPASS_POSTURE_TOLERANCE;
}

/**
 * Applied about world up and held between refreshes, not folded into `alpha`:
 * `360 - webkitCompassHeading` assumes the phone is flat, and applying it
 * continuously spins the sky as the device tilts.
 */
export function compassYawOffset(sample: DeviceOrientationSample, compassHeading: number): number {
  return normalizeAzimuth(360 - compassHeading - sample.alpha);
}

export interface HeadingReading {
  /** Safari only. */
  compassHeading?: number | undefined;
  /** Whether alpha is already referenced to true north. */
  absolute?: boolean;
}

/** Whatever the current posture. */
export const hasHeadingSource = (reading: HeadingReading): boolean => reading.absolute === true || reading.compassHeading !== undefined;

/** Refreshes the yaw offset only from readings that justify it. */
export class CompassCalibration {
  #offset = 0;

  #calibrated = false;

  get calibrated(): boolean {
    return this.#calibrated;
  }

  update(sample: DeviceOrientationSample, reading: HeadingReading): void {
    // Absolute alpha is already measured from north, in any posture.
    if (reading.absolute) {
      this.#offset = 0;
      this.#calibrated = true;
      return;
    }
    if (reading.compassHeading === undefined || !compassIsMeaningful(sample)) {
      return;
    }
    this.#offset = compassYawOffset(sample, reading.compassHeading);
    this.#calibrated = true;
  }

  correct(aim: Aim): Aim {
    return { ...aim, azimuth: normalizeAzimuth(aim.azimuth + this.#offset) };
  }
}
