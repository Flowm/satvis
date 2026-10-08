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

/** Whether a reading can establish north, in any posture. */
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

/**
 * A laptop, a declined permission and a missing magnetometer each need different words.
 * See docs/adr/0004-compass-aiming.md.
 */
export type CompassOutcome =
  | "aiming"
  /** Aiming, but north waits on the phone being held flat once. */
  | "aiming-uncalibrated"
  | "unsupported"
  | "denied"
  /** Granted, but never fired. Desktop browsers do this. */
  | "silent"
  /** Orientation works, but nothing on this device knows north. */
  | "no-heading"
  /** The user took the aim back by hand during the probe. Nothing to report, but the control must hear it. */
  | "taken-back";

/** One orientation event, as the browser's `deviceorientation` and `deviceorientationabsolute` carry it. */
export interface OrientationEvent {
  type: string;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute: boolean;
  /** Safari only. */
  webkitCompassHeading?: number;
}

/** Where orientation events come from. */
export interface OrientationEvents {
  /** False where the browser has no orientation events at all. */
  readonly supported: boolean;
  /** iOS gates the sensor behind this, called from a user gesture, over https only. Absent elsewhere. */
  requestPermission?: () => Promise<string>;
  /** Both event types; returns the removal. */
  listen(listener: (event: OrientationEvent) => void): () => void;
  /** `screen.orientation.angle`. */
  screenAngle(): number;
}

/**
 * The browser's. `deviceorientationabsolute` is the only source of north on Android;
 * `deviceorientation` carries `webkitCompassHeading` on iOS.
 */
export function browserOrientationEvents(): OrientationEvents {
  const supported = typeof DeviceOrientationEvent !== "undefined";
  const gate = supported ? (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }) : undefined;
  return {
    supported,
    ...(typeof gate?.requestPermission === "function" && { requestPermission: () => gate.requestPermission!() }),
    listen(listener) {
      const handler = (event: Event) => listener(event as unknown as OrientationEvent);
      window.addEventListener("deviceorientationabsolute", handler);
      window.addEventListener("deviceorientation", handler);
      return () => {
        window.removeEventListener("deviceorientationabsolute", handler);
        window.removeEventListener("deviceorientation", handler);
      };
    },
    screenAngle: () => screen.orientation?.angle ?? 0,
  };
}

const SENSOR_PROBE_MS = 1200;

export interface CompassAimingOptions {
  events: OrientationEvents;
  /** Applies an aim; omitted angles keep their value. */
  look: (aim: Partial<Aim>) => void;
  /** Resolves after `ms`; a test passes its own clock. */
  wait?: (ms: number) => Promise<void>;
}

/** Aiming the sky view by the device's orientation and compass (docs/adr/0004-compass-aiming.md). */
export class CompassAiming {
  readonly calibration = new CompassCalibration();

  readonly #options: CompassAimingOptions;

  #unlisten: (() => void) | undefined;

  #sawOrientation = false;

  #sawHeadingSource = false;

  #stopped: (() => void) | undefined;

  constructor(options: CompassAimingOptions) {
    this.#options = options;
  }

  get active(): boolean {
    return this.#unlisten !== undefined;
  }

  /** Called whenever aiming stops, however: the control cannot see a drag take the aim back. */
  onStop(callback: () => void): void {
    this.#stopped = callback;
  }

  /**
   * Must be called from a user gesture. The sensor then has to prove itself: desktop
   * browsers grant the event and never fire it, which would freeze the view.
   */
  async enable(): Promise<CompassOutcome> {
    if (this.active) {
      return this.calibration.calibrated ? "aiming" : "aiming-uncalibrated";
    }
    const { events } = this.#options;
    if (!events.supported) {
      return "unsupported";
    }
    if (events.requestPermission) {
      try {
        if ((await events.requestPermission()) !== "granted") {
          return "denied";
        }
      } catch {
        // Thrown outside a gesture.
        return "denied";
      }
    }
    this.#sawOrientation = false;
    this.#sawHeadingSource = false;
    this.#unlisten = events.listen(this.#onOrientation);

    await (this.#options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(SENSOR_PROBE_MS);
    // A drag can take the aim back during the probe; report what is in force.
    if (!this.active) {
      return "taken-back";
    }
    if (!this.#sawOrientation) {
      this.disable();
      return "silent";
    }
    // Without north, the azimuth would be measured from wherever the device happened to point.
    if (!this.#sawHeadingSource) {
      this.disable();
      return "no-heading";
    }
    return this.calibration.calibrated ? "aiming" : "aiming-uncalibrated";
  }

  /**
   * Levels the view on the way out: only the sensor rolls it, so a leftover roll is one
   * the pointer cannot straighten.
   */
  disable(): void {
    if (!this.#unlisten) {
      return;
    }
    this.#unlisten();
    this.#unlisten = undefined;
    this.#options.look({ roll: 0 });
    this.#stopped?.();
  }

  #onOrientation = (event: OrientationEvent): void => {
    const { alpha, beta, gamma } = event;
    if (alpha === null || beta === null || gamma === null) {
      return;
    }
    this.#sawOrientation = true;
    const sample = { alpha, beta, gamma, screenAngle: this.#options.events.screenAngle() };
    // `deviceorientation` sets `absolute` false too; that says nothing about iOS's heading.
    const reading = { compassHeading: event.webkitCompassHeading, absolute: event.type === "deviceorientationabsolute" && event.absolute };
    this.#sawHeadingSource ||= hasHeadingSource(reading);
    // The compass is a yaw offset about world up, never folded into alpha.
    this.calibration.update(sample, reading);
    this.#options.look(this.calibration.correct(aimFromDeviceOrientation(sample)));
  };
}
