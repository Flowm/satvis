// Where things are in the observer's sky, and where that lands on screen.
//
// The HUD tapes project through Cesium like the satellites do. A linear
// `(azimuth - heading) * pixelsPerDegree` breaks at the zenith, where the derived
// heading flips by 180°, and cannot express roll.

import { Cartesian2, Cartesian3, Cartographic, Math as CesiumMath, JulianDate, Matrix3, Ray, type Scene, SceneTransforms } from "@cesium/engine";

import type { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import { enuDirection, normalizeAzimuth, type ObserverFrame } from "./skyGeometry";
import { inEarthShadow, sunDirection, type Visibility, visibility } from "./util/visibility";

export { type ObserverFrame, observerFrame } from "./skyGeometry";

export interface LookAngles {
  /** Degrees clockwise from north. */
  azimuth: number;
  /** Degrees above the horizon; negative is below it. */
  elevation: number;
  rangeKm: number;
}

export interface SkyTarget extends LookAngles {
  sat: SatelliteComponentCollection;
  name: string;
  altitudeKm: number;
  /** Fixed frame. */
  position: Cartesian3;
  /** In CSS pixels; undefined when behind the camera. */
  window: Cartesian2 | undefined;
  visibility: Visibility;
}

/** In metres. Any distance works if it dwarfs the eye height. */
const DIRECTION_DISTANCE = 1e7;

export function lookAngles(frame: ObserverFrame, target: Cartesian3): LookAngles {
  const delta = Cartesian3.subtract(target, frame.position, new Cartesian3());
  const range = Cartesian3.magnitude(delta);
  if (range === 0) {
    return { azimuth: 0, elevation: 0, rangeKm: 0 };
  }
  const local = Matrix3.multiplyByVector(frame.fixedToEnu, delta, new Cartesian3());
  const azimuth = normalizeAzimuth(CesiumMath.toDegrees(Math.atan2(local.x, local.y)));
  const elevation = CesiumMath.toDegrees(Math.asin(CesiumMath.clamp(local.z / range, -1, 1)));
  return { azimuth, elevation, rangeKm: range / 1000 };
}

export function directionToWorld(frame: ObserverFrame, azimuth: number, elevation: number, distance = DIRECTION_DISTANCE): Cartesian3 {
  const local = enuDirection(azimuth, elevation, distance);
  const enuToFixed = Matrix3.transpose(frame.fixedToEnu, new Matrix3());
  const offset = Matrix3.multiplyByVector(enuToFixed, local, new Cartesian3());
  return Cartesian3.add(frame.position, offset, offset);
}

/** Degrees above the observer's horizon; `sun` is a unit vector from `sunDirection`. */
export function sunElevation(frame: ObserverFrame, sun: Cartesian3): number {
  const local = Matrix3.multiplyByVector(frame.fixedToEnu, sun, new Cartesian3());
  return CesiumMath.toDegrees(Math.asin(CesiumMath.clamp(local.z, -1, 1)));
}

/** Where a direction from the observer lands on screen, in CSS pixels. */
export function directionToWindow(scene: Scene, frame: ObserverFrame, azimuth: number, elevation: number): Cartesian2 | undefined {
  return SceneTransforms.worldToWindowCoordinates(scene, directionToWorld(frame, azimuth, elevation));
}

/** Positions come from the entity's sampled property, so a target is where Cesium draws it. */
export function skyTargets(scene: Scene, frame: ObserverFrame, satellites: readonly SatelliteComponentCollection[], time: JulianDate): SkyTarget[] {
  const sun = sunDirection(JulianDate.toDate(time).getTime(), new Cartesian3());
  const elevationOfSun = sunElevation(frame, sun);
  const targets: SkyTarget[] = [];
  for (const sat of satellites) {
    const position = sat.props.trajectory.position(time);
    if (!position) {
      continue;
    }
    const angles = lookAngles(frame, position);
    targets.push({
      ...angles,
      sat,
      name: sat.props.name,
      position,
      // Height above the ellipsoid: geocentric radius varies 6357-6378 km with
      // latitude, a ~12 km bias.
      altitudeKm: (Cartographic.fromCartesian(position)?.height ?? 0) / 1000,
      window: SceneTransforms.worldToWindowCoordinates(scene, position),
      visibility: visibility(elevationOfSun, !inEarthShadow(position, sun), angles.rangeKm),
    });
  }
  return targets;
}

/** Reused: the ray is cast per candidate per frame. */
const occlusionRay = new Ray();
const occlusionHit = new Cartesian3();

/**
 * Keeps the crosshair consistent with the terrain depth test (`SkyView#enter`).
 * Picks against last frame's globe tiles, so it is false under a surface model.
 */
export function groundHides(scene: Scene, frame: ObserverFrame, position: Cartesian3): boolean {
  const direction = Cartesian3.subtract(position, frame.position, occlusionRay.direction);
  const range = Cartesian3.magnitude(direction);
  if (range === 0) {
    return false;
  }
  Cartesian3.divideByScalar(direction, range, direction);
  Cartesian3.clone(frame.position, occlusionRay.origin);
  const hit = scene.globe.pick(occlusionRay, scene, occlusionHit);
  return hit !== undefined && Cartesian3.distance(frame.position, hit) < range;
}

/**
 * Not `scene.pick`: its rectangle is in drawing-buffer pixels, so a CSS-pixel
 * radius would change with `?pixelratio`, and it searches in square rings rather
 * than by true distance. Targets below the horizon are dropped, not depth-tested.
 * `hidden` (a terrain ray) is asked nearest first, only until one passes.
 */
export function nearestTarget(targets: readonly SkyTarget[], center: Cartesian2, radiusPx: number, hidden: (target: SkyTarget) => boolean = () => false): SkyTarget | undefined {
  const inReach: { target: SkyTarget; distance: number }[] = [];
  for (const target of targets) {
    if (!target.window || target.elevation <= 0) {
      continue;
    }
    const distance = Cartesian2.distance(target.window, center);
    if (distance <= radiusPx) {
      inReach.push({ target, distance });
    }
  }
  return inReach.toSorted((a, b) => a.distance - b.distance).find(({ target }) => !hidden(target))?.target;
}

export function compassPoint(azimuth: number): string {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const index = Math.round(normalizeAzimuth(azimuth) / 22.5) % points.length;
  return points[index] as string;
}
