import { Cartesian3, Math as CesiumMath, Matrix3 } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import {
  aimFromDeviceOrientation,
  CompassAiming,
  CompassCalibration,
  compassIsMeaningful,
  compassYawOffset,
  type DeviceOrientationSample,
  hasHeadingSource,
  normalizeAzimuth,
  type OrientationEvent,
} from "./DeviceAim";
import type { Aim } from "./skyGeometry";
import { skyBasis } from "./SkyView";

const sample = (alpha: number, beta: number, gamma: number, screenAngle = 0): DeviceOrientationSample => ({ alpha, beta, gamma, screenAngle });

const azimuthError = (actual: number, expected: number): number => Math.abs(((((actual - expected) % 360) + 540) % 360) - 180);

/**
 * Built from the `deviceorientation` Euler order, not the module, so the round trip checks against the spec.
 */
function deviceRotationForTest({ alpha, beta, gamma, screenAngle }: DeviceOrientationSample): { backCamera: Cartesian3; screenUp: Cartesian3 } {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const rotation = [
    Matrix3.fromRotationZ(radians(alpha)),
    Matrix3.fromRotationX(radians(beta)),
    Matrix3.fromRotationY(radians(gamma)),
    Matrix3.fromRotationZ(radians(-screenAngle)),
  ].reduce((accumulated, next) => Matrix3.multiply(accumulated, next, new Matrix3()));
  return {
    backCamera: Matrix3.multiplyByVector(rotation, new Cartesian3(0, 0, -1), new Cartesian3()),
    screenUp: Matrix3.multiplyByVector(rotation, new Cartesian3(0, 1, 0), new Cartesian3()),
  };
}

describe("aimFromDeviceOrientation", () => {
  test("looks straight down when the phone lies flat, screen up", () => {
    // The rear camera faces the table.
    expect(aimFromDeviceOrientation(sample(0, 0, 0)).pitch).toBeCloseTo(-90, 9);
  });

  test("looks straight up when the phone lies face down", () => {
    // Rear camera to the sky — the posture the whole feature is for.
    expect(aimFromDeviceOrientation(sample(0, 180, 0)).pitch).toBeCloseTo(90, 9);
  });

  test("looks level at the horizon when the phone is held upright", () => {
    const aim = aimFromDeviceOrientation(sample(0, 90, 0));
    expect(aim.pitch).toBeCloseTo(0, 9);
    expect(azimuthError(aim.azimuth, 0)).toBeLessThan(1e-9);
    expect(aim.roll).toBeCloseTo(0, 9);
  });

  test("carries alpha into the azimuth while upright", () => {
    for (const alpha of [0, 45, 90, 200, 350]) {
      const aim = aimFromDeviceOrientation(sample(alpha, 90, 0));
      // Alpha turns the device anticlockwise seen from above, so the view
      // heading runs the other way.
      expect(azimuthError(aim.azimuth, -alpha), `alpha=${alpha}`).toBeLessThan(1e-6);
    }
  });

  test("tilts pitch with beta between upright and the zenith", () => {
    expect(aimFromDeviceOrientation(sample(0, 135, 0)).pitch).toBeCloseTo(45, 6);
    expect(aimFromDeviceOrientation(sample(0, 45, 0)).pitch).toBeCloseTo(-45, 6);
  });

  test("swings the azimuth, not the roll, when an upright phone tips sideways", () => {
    // Held upright, gamma's axis is vertical: tipping sideways turns the camera
    // along the horizon and keeps the horizon level.
    const aim = aimFromDeviceOrientation(sample(0, 90, 30));
    expect(aim.pitch).toBeCloseTo(0, 6);
    expect(azimuthError(aim.azimuth, -30)).toBeLessThan(1e-6);
    expect(aim.roll).toBeCloseTo(0, 6);
  });

  test("takes the roll out again when the screen rotates to match", () => {
    // A landscape screen on a device turned 90° should read level, not rolled:
    // the display turned with the hardware.
    const upright = aimFromDeviceOrientation(sample(0, 90, 0, 0));
    const landscape = aimFromDeviceOrientation(sample(0, 90, 0, 90));
    expect(upright.roll).toBeCloseTo(0, 6);
    expect(Math.abs(landscape.roll)).toBeCloseTo(90, 6);
  });

  test("hands the camera back the orientation the device reported", () => {
    // Decomposing into an aim and recomposing into a camera basis must give back
    // the device's axes; a roll sign mismatch mirrors the sky.
    for (const posture of [sample(0, 90, 0, 90), sample(40, 120, 20, 0), sample(200, 150, -35, 270)]) {
      const basis = skyBasis(aimFromDeviceOrientation(posture));
      const rotation = deviceRotationForTest(posture);
      const label = `a=${posture.alpha} b=${posture.beta} g=${posture.gamma} s=${posture.screenAngle}`;

      expect(CesiumMath.toDegrees(Cartesian3.angleBetween(basis.direction, rotation.backCamera)), label).toBeCloseTo(0, 6);
      expect(CesiumMath.toDegrees(Cartesian3.angleBetween(basis.up, rotation.screenUp)), label).toBeCloseTo(0, 6);
    }
  });

  test("stays finite and level-consistent pointing at the zenith", () => {
    // An Euler-derived roll is undefined here.
    const aim = aimFromDeviceOrientation(sample(217, 180, 0));
    expect(aim.pitch).toBeCloseTo(90, 9);
    expect(Number.isFinite(aim.azimuth)).toBe(true);
    expect(Number.isFinite(aim.roll)).toBe(true);
  });
});

describe("compassIsMeaningful", () => {
  test("accepts a phone lying flat, either face", () => {
    expect(compassIsMeaningful(sample(0, 0, 0))).toBe(true);
    expect(compassIsMeaningful(sample(0, 180, 0))).toBe(true);
    expect(compassIsMeaningful(sample(0, 20, 0))).toBe(true);
  });

  test("rejects the posture the sky view is actually used in", () => {
    // Held up toward the sky, where `360 - webkitCompassHeading` stops holding
    // and using it anyway would spin the view.
    expect(compassIsMeaningful(sample(0, 90, 0))).toBe(false);
    expect(compassIsMeaningful(sample(0, 120, 0))).toBe(false);
    expect(compassIsMeaningful(sample(0, 90, 60))).toBe(false);
  });
});

describe("compassYawOffset", () => {
  test("cancels alpha so the corrected azimuth is the compass heading", () => {
    for (const [alpha, heading] of [
      [0, 0],
      [90, 30],
      [200, 145],
      [350, 359],
    ]) {
      const offset = compassYawOffset(sample(alpha as number, 0, 0), heading as number);
      expect(normalizeAzimuth((alpha as number) + offset)).toBeCloseTo(normalizeAzimuth(360 - (heading as number)), 6);
    }
  });
});

describe("CompassCalibration", () => {
  test("starts uncalibrated and leaves the aim alone", () => {
    const calibration = new CompassCalibration();
    expect(calibration.calibrated).toBe(false);
    expect(calibration.correct({ azimuth: 123, pitch: 10, roll: 0 }).azimuth).toBe(123);
  });

  test("refuses to calibrate from a posture that cannot support it", () => {
    const calibration = new CompassCalibration();
    calibration.update(sample(0, 90, 0), { compassHeading: 90 });
    expect(calibration.calibrated).toBe(false);
  });

  test("calibrates from a flat posture and then holds through the tilt", () => {
    const calibration = new CompassCalibration();
    calibration.update(sample(10, 0, 0), { compassHeading: 40 });
    expect(calibration.calibrated).toBe(true);
    const afterFlat = calibration.correct({ azimuth: 10, pitch: 0, roll: 0 }).azimuth;

    // Tilting up must not move the offset, even with a wildly different heading.
    calibration.update(sample(10, 140, 0), { compassHeading: 300 });
    expect(calibration.correct({ azimuth: 10, pitch: 50, roll: 0 }).azimuth).toBeCloseTo(afterFlat, 9);
  });

  test("ignores a device with no compass at all", () => {
    const calibration = new CompassCalibration();
    calibration.update(sample(0, 0, 0), {});
    expect(calibration.calibrated).toBe(false);
  });

  test("an absolute reading calibrates at any posture and corrects by nothing", () => {
    const calibration = new CompassCalibration();
    // Screen pointed at the zenith, where iOS's heading would be meaningless.
    calibration.update(sample(37, 90, 0), { absolute: true });
    expect(calibration.calibrated).toBe(true);
    expect(calibration.correct({ azimuth: 123, pitch: 60, roll: 0 }).azimuth).toBeCloseTo(123, 9);
  });

  test("an absolute reading wins over a heading measured in the same event", () => {
    const calibration = new CompassCalibration();
    calibration.update(sample(10, 0, 0), { compassHeading: 40, absolute: true });
    expect(calibration.correct({ azimuth: 10, pitch: 0, roll: 0 }).azimuth).toBeCloseTo(10, 9);
  });

  test("wraps rather than running past a full turn", () => {
    const calibration = new CompassCalibration();
    // alpha 0 with the phone flat facing 60° puts the offset at 300.
    calibration.update(sample(0, 0, 0), { compassHeading: 60 });
    expect(calibration.correct({ azimuth: 100, pitch: 0, roll: 0 }).azimuth).toBeCloseTo(40, 9);
  });
});

describe("hasHeadingSource", () => {
  test("a bare relative reading cannot establish north", () => {
    expect(hasHeadingSource({})).toBe(false);
    expect(hasHeadingSource({ absolute: false })).toBe(false);
  });

  test("either source will do", () => {
    expect(hasHeadingSource({ compassHeading: 0 })).toBe(true);
    expect(hasHeadingSource({ absolute: true })).toBe(true);
  });
});

describe("CompassAiming", () => {
  /** An orientation source the test fires, and a probe that ends when the test says. */
  function setup({ supported = true, permission }: { supported?: boolean; permission?: () => Promise<string> } = {}) {
    const listeners = new Set<(event: OrientationEvent) => void>();
    const looks: Partial<Aim>[] = [];
    let endProbe = () => {};
    const aiming = new CompassAiming({
      events: {
        supported,
        ...(permission && { requestPermission: permission }),
        listen: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
        screenAngle: () => 0,
      },
      look: (aim) => looks.push(aim),
      wait: () => new Promise((resolve) => (endProbe = () => resolve())),
    });
    const fire = (event: Partial<OrientationEvent>) =>
      listeners.forEach((listener) => listener({ type: "deviceorientation", alpha: 10, beta: 20, gamma: 0, absolute: false, ...event }));
    const probe = async (during: () => void = () => {}) => {
      const outcome = aiming.enable();
      await Promise.resolve();
      await Promise.resolve();
      during();
      endProbe();
      return outcome;
    };
    return { aiming, fire, probe, looks, listening: () => listeners.size };
  }

  test("aims from a device that knows north, flat or not", async () => {
    const { aiming, fire, probe, looks } = setup();
    expect(await probe(() => fire({ type: "deviceorientationabsolute", absolute: true }))).toBe("aiming");
    expect(aiming.active).toBe(true);
    expect(looks).toHaveLength(1);
  });

  test("aims uncalibrated until an iOS phone is held flat", async () => {
    const { probe, fire } = setup();
    // Pointed near the zenith, where the compass heading swings.
    expect(await probe(() => fire({ beta: 90, webkitCompassHeading: 100 }))).toBe("aiming-uncalibrated");
  });

  test("says so where the browser has no orientation events", async () => {
    expect(await setup({ supported: false }).probe()).toBe("unsupported");
  });

  test("is denied when the permission is refused, or asked for outside a gesture", async () => {
    expect(await setup({ permission: () => Promise.resolve("denied") }).probe()).toBe("denied");
    expect(await setup({ permission: () => Promise.reject(new Error("not a gesture")) }).probe()).toBe("denied");
  });

  test("gives up on a sensor that never fires, as desktop browsers grant and stay silent", async () => {
    const { aiming, probe, listening } = setup();
    expect(await probe()).toBe("silent");
    expect(aiming.active).toBe(false);
    expect(listening()).toBe(0);
  });

  test("gives up on orientation without north", async () => {
    const { aiming, fire, probe } = setup();
    expect(await probe(() => fire({}))).toBe("no-heading");
    expect(aiming.active).toBe(false);
  });

  test("reports a probe the user took the aim back from by hand", async () => {
    const { aiming, fire, probe } = setup();
    expect(await probe(() => (fire({ type: "deviceorientationabsolute", absolute: true }), aiming.disable()))).toBe("taken-back");
  });

  test("levels the view and tells the control when it stops", async () => {
    const { aiming, fire, probe, looks } = setup();
    let stopped = 0;
    aiming.onStop(() => (stopped += 1));
    await probe(() => fire({ type: "deviceorientationabsolute", absolute: true }));

    aiming.disable();
    aiming.disable();

    expect(looks.at(-1)).toEqual({ roll: 0 });
    expect(stopped).toBe(1);
  });
});
