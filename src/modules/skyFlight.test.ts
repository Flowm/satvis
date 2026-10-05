import { Cartesian3, Math as CesiumMath, Quaternion } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { easeFlight, type FlightPath, flightPose, flightPosition, LOCK_ON, newPose, type Pose, poseRotation, TIP_UP, TOUCHDOWN } from "./skyFlight";

const EARTH_RADIUS = 6378137;

const at = (x: number, y: number, z: number, radius: number): Cartesian3 =>
  Cartesian3.multiplyByScalar(Cartesian3.normalize(new Cartesian3(x, y, z), new Cartesian3()), radius, new Cartesian3());

const pose = (position: Cartesian3, direction: Cartesian3, up: Cartesian3, fovy = 60): Pose => {
  const d = Cartesian3.normalize(direction, new Cartesian3());
  const u = Cartesian3.normalize(up, new Cartesian3());
  return { position, direction: d, up: u, right: Cartesian3.cross(d, u, new Cartesian3()), fovy };
};

const angleDegrees = (a: Cartesian3, b: Cartesian3): number => CesiumMath.toDegrees(Cartesian3.angleBetween(a, b));

/** In degrees, the short way round. */
function turnBetween(a: Pose, b: Pose): number {
  const from = poseRotation(a, new Quaternion());
  const to = poseRotation(b, new Quaternion());
  const delta = Quaternion.multiply(to, Quaternion.conjugate(from, new Quaternion()), new Quaternion());
  return CesiumMath.toDegrees(2 * Math.acos(Math.min(1, Math.abs(delta.w))));
}

/** A camera in orbit over the Gulf of Guinea, looking straight down with north up. */
const orbit = pose(at(1, 0, 0, EARTH_RADIUS + 20_000_000), new Cartesian3(-1, 0, 0), new Cartesian3(0, 0, 1), 36);

/** The destination is on the equator a quarter turn east, with these local axes. */
const destination = at(0, 1, 0, EARTH_RADIUS + 2);
const EAST = new Cartesian3(-1, 0, 0);
const NORTH = new Cartesian3(0, 0, 1);
const UP = new Cartesian3(0, 1, 0);

/** Facing north, 45° above the horizon: the aim the flight ends on. */
const ground = pose(destination, new Cartesian3(0, 1, 1), new Cartesian3(0, 1, -1), 75);

/**
 * `ground` tipped to -90°. `up` is north, the limit `skyBasis` gives, so the rise is pure pitch.
 */
const overGround = pose(destination, Cartesian3.negate(UP, new Cartesian3()), NORTH);

const path: FlightPath = { from: orbit, to: ground, over: overGround };

describe("flightPosition", () => {
  const between = (from: Cartesian3, to: Cartesian3, sweep: number, drop = sweep): Cartesian3 => flightPosition(from, to, sweep, drop, new Cartesian3());

  test("starts and ends exactly where it was told to", () => {
    expect(Cartesian3.distance(between(orbit.position, destination, 0), orbit.position)).toBeLessThan(1e-6);
    expect(Cartesian3.distance(between(orbit.position, destination, 1), destination)).toBeLessThan(1e-6);
  });

  test("follows the great circle rather than the chord", () => {
    const total = angleDegrees(orbit.position, destination);
    for (const t of [0.25, 0.5, 0.75]) {
      expect(angleDegrees(orbit.position, between(orbit.position, destination, t))).toBeCloseTo(total * t, 6);
    }
  });

  test("comes down where it is told to, independently of how far round it has come", () => {
    // The two fractions must not leak into each other.
    const overhead = between(orbit.position, destination, 1, 0.4);
    expect(angleDegrees(overhead, destination)).toBeCloseTo(0, 9);
    const radii = [Cartesian3.magnitude(orbit.position), Cartesian3.magnitude(destination)];
    expect(Cartesian3.magnitude(overhead)).toBeCloseTo(radii[0]! + 0.4 * (radii[1]! - radii[0]!), 6);
  });

  test("never dips below either end, so no arc height is needed to clear the ground", () => {
    const low = Math.min(Cartesian3.magnitude(orbit.position), Cartesian3.magnitude(destination));
    for (let t = 0; t <= 1; t += 0.02) {
      expect(Cartesian3.magnitude(between(orbit.position, destination, Math.min(1, t * 1.4), t))).toBeGreaterThanOrEqual(low - 1e-6);
    }
  });

  test("crosses the planet from the antipode without going through it", () => {
    // Antipodal: the cross product vanishes, which would give a NaN axis.
    const from = at(1, 0, 0, EARTH_RADIUS + 1_000_000);
    const to = at(-1, 0, 0, EARTH_RADIUS + 2);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const step = between(from, to, t);
      expect(Number.isFinite(step.x) && Number.isFinite(step.y) && Number.isFinite(step.z)).toBe(true);
      expect(angleDegrees(from, step)).toBeCloseTo(180 * t, 6);
    }
  });

  test("stays put when both ends are the same place", () => {
    const here = at(0.3, -0.9, 0.2, EARTH_RADIUS + 2);
    expect(Cartesian3.distance(between(here, here, 0.5), here)).toBeLessThan(1e-6);
  });
});

describe("flightPose", () => {
  const step = (t: number): Pose => flightPose(path, t, newPose());

  // In degrees.
  const offCentre = (here: Pose): number => angleDegrees(here.direction, Cartesian3.subtract(destination, here.position, new Cartesian3()));

  test("starts and ends on the poses it was given", () => {
    for (const [t, end] of [
      [0, orbit],
      [1, ground],
    ] as const) {
      const here = step(t);
      expect(Cartesian3.distance(here.position, end.position)).toBeLessThan(1e-6);
      expect(angleDegrees(here.direction, end.direction)).toBeCloseTo(0, 6);
      expect(angleDegrees(here.up, end.up)).toBeCloseTo(0, 6);
      expect(angleDegrees(here.right, end.right)).toBeCloseTo(0, 6);
      expect(here.fovy).toBeCloseTo(end.fovy, 9);
    }
  });

  test("holds the destination at the centre of the screen for the whole descent", () => {
    for (let t = LOCK_ON; t <= 1 - TIP_UP; t += 0.02) {
      expect(offCentre(step(t)), `t=${t.toFixed(2)}`).toBeLessThan(1e-4);
    }
  });

  test("brings the destination in without overshooting it", () => {
    // Monotone through the swing, with no overshoot. It starts only 13° off: a
    // quarter of the globe subtends little from 20,000 km up.
    let previous = offCentre(step(0));
    expect(previous).toBeGreaterThan(10);
    for (let t = 0.01; t <= LOCK_ON; t += 0.01) {
      const off = offCentre(step(t));
      // A tenth of a degree of slack: the camera moves, so the swing trails the destination slightly.
      expect(off, `t=${t.toFixed(2)}`).toBeLessThanOrEqual(previous + 0.1);
      previous = Math.min(previous, off);
    }
    expect(previous).toBeLessThan(0.1);
  });

  test("comes to rest directly over the destination as the rise begins", () => {
    // Arriving vertically, not along the swoop's tangent, so the aim does not whip at the end.
    const overhead = step(1 - TIP_UP);
    expect(angleDegrees(overhead.position, destination)).toBeCloseTo(0, 9);
    expect(Cartesian3.magnitude(overhead.position)).toBeGreaterThan(Cartesian3.magnitude(destination));
  });

  test("is standing on the destination before the rise finishes", () => {
    expect(Cartesian3.distance(step(TOUCHDOWN).position, destination)).toBeLessThan(1e-6);
    expect(angleDegrees(step(TOUCHDOWN).direction, ground.direction)).toBeGreaterThan(30);
  });

  test("rises through the horizon rather than around it", () => {
    // A pure pitch change: the view stays in the vertical plane whose normal is east here.
    for (let t = 1 - TIP_UP; t <= 1; t += 0.02) {
      const here = step(t);
      expect(Cartesian3.dot(here.direction, EAST), `t=${t.toFixed(2)}`).toBeCloseTo(0, 6);
      expect(Cartesian3.dot(here.up, EAST), `t=${t.toFixed(2)}`).toBeCloseTo(0, 6);
    }
  });

  test("hands the camera an orthonormal right-handed basis at every step", () => {
    // Separately interpolated vectors are not orthonormal in between, and Cesium shears the picture.
    for (let t = 0; t <= 1; t += 0.02) {
      const { direction, up, right } = step(t);
      const label = `t=${t.toFixed(2)}`;

      expect(Cartesian3.magnitude(direction), label).toBeCloseTo(1, 9);
      expect(Cartesian3.magnitude(up), label).toBeCloseTo(1, 9);
      expect(Cartesian3.magnitude(right), label).toBeCloseTo(1, 9);
      expect(Cartesian3.dot(direction, up), label).toBeCloseTo(0, 9);
      expect(Cartesian3.dot(direction, right), label).toBeCloseTo(0, 9);
      expect(Cartesian3.dot(up, right), label).toBeCloseTo(0, 9);

      const cross = Cartesian3.cross(direction, up, new Cartesian3());
      expect(angleDegrees(cross, right), label).toBeCloseTo(0, 6);
    }
  });

  test("takes the short way round rather than spinning to the same attitude", () => {
    // `Quaternion.slerp` negates one end when the two point away from each other.
    // A long way round is smooth, so only the total turn catches it.
    let travelled = 0;
    let previous = step(0);
    for (let t = 0.005; t <= 1; t += 0.005) {
      const next = step(t);
      travelled += turnBetween(previous, next);
      previous = next;
    }
    // 90° to straight down, 135° of rise, plus slack for the descent's tracking.
    expect(travelled).toBeLessThan(turnBetween(orbit, overGround) + turnBetween(overGround, ground) + 45);
  });

  test("moves smoothly, with no jump at either join between legs", () => {
    const dt = 0.002;
    let previous = step(0);
    for (let t = dt; t <= 1; t += dt) {
      const next = step(t);
      const label = `t=${t.toFixed(3)}`;
      // About triple the fastest legitimate turn (mid-descent); a broken join shows as tens of degrees.
      expect(angleDegrees(previous.direction, next.direction), label).toBeLessThan(3);
      expect(angleDegrees(previous.up, next.up), label).toBeLessThan(3);
      previous = next;
    }
  });

  test("widens the field of view on the way in, and has finished by the landing", () => {
    expect(step(0.4).fovy).toBeGreaterThan(orbit.fovy);
    expect(step(0.4).fovy).toBeLessThan(ground.fovy);
    // Steady through the rise.
    expect(step(TOUCHDOWN).fovy).toBeCloseTo(ground.fovy, 9);
  });

  test("stays defined once the camera is standing on the point it is aiming at", () => {
    // Past touchdown there is no line of sight left; a cross-product look-at would divide by zero.
    for (let t = TOUCHDOWN; t <= 1; t += 0.01) {
      const { direction, up, right } = step(t);
      const finite = (v: Cartesian3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
      expect(finite(direction) && finite(up) && finite(right), `t=${t.toFixed(2)}`).toBe(true);
    }
  });
});

describe("poseRotation", () => {
  test("is a unit rotation, which is what the blend and the conversion back need", () => {
    for (const p of [orbit, ground, overGround]) {
      expect(Quaternion.magnitude(poseRotation(p, new Quaternion()))).toBeCloseTo(1, 9);
    }
  });
});

describe("easeFlight", () => {
  test("pins both ends, so the flight lands exactly on its destination", () => {
    expect(easeFlight(0)).toBe(0);
    expect(easeFlight(1)).toBe(1);
  });

  test("clamps, because that is also how each leg is scheduled off the shared clock", () => {
    expect(easeFlight(-0.5)).toBe(0);
    expect(easeFlight(1.7)).toBe(1);
  });

  test("never goes backwards", () => {
    let previous = 0;
    for (let t = 0; t <= 1; t += 0.01) {
      const eased = easeFlight(t);
      expect(eased).toBeGreaterThanOrEqual(previous);
      previous = eased;
    }
  });
});
