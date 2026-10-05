// The sky view overlay's geometry: tape ticks, the locked satellite and its track.
// Positions go through Cesium's projection, never `(azimuth - heading) * pixelsPerDegree`:
// that shortcut flips the heading by 180° when the camera crosses the zenith.

import { type Cartesian3, Math as CesiumMath, JulianDate, type Scene, SceneTransforms } from "@cesium/engine";
import { shallowRef, type ShallowRef } from "vue";

import type { CesiumController } from "../modules/CesiumController";
import { normalizeAzimuth } from "../modules/skyGeometry";
import { compassPoint, directionToWindow, groundHides, lookAngles, type ObserverFrame, type SkyTarget } from "../modules/SkyTargets";
import { fovxFromFovy } from "../modules/SkyView";

/** A mark on one of the tapes, already placed in CSS pixels. */
export interface TapeTick {
  /** Degrees: azimuth on the compass, elevation on the side tape. */
  value: number;
  offset: number;
  label: string | undefined;
  major: boolean;
}

/**
 * Coarsest first. Every rung divides 45, so the compass points stay majors, and no
 * rung is more than 3x the next, which bounds the mark count. A 45° rung is left out:
 * entering it thinned the tape from nine marks to three.
 */
const STEP_LADDER = [15, 5, 3, 1];

/**
 * Keeps 15° on a landscape desktop at the default zoom and about 3-10 marks elsewhere.
 * Four is worse: at a 17° span it skips 5° and lands on 1°, which gives seventeen marks.
 */
export const TICKS_WANTED = 3;

export const stepFor = (spanDegrees: number): number => STEP_LADDER.find((step) => spanDegrees / step >= TICKS_WANTED) ?? 1;

/** Majors carry the labels. */
export const majorStep = (step: number): number => step * 3;

/**
 * Pixels from the left edge. The perspective `tan` mapping without the pitch term:
 * exact at eye level, the same scale elsewhere (see `refresh`).
 */
export const headingOffset = (deltaAzimuth: number, halfWidth: number, tanHalfSpan: number): number =>
  halfWidth + (halfWidth * Math.tan(CesiumMath.toRadians(deltaAzimuth))) / tanHalfSpan;

/** CSS pixels. Only the elevation tape, compressed toward the zenith, ever hits it. */
const MIN_TICK_SPACING = 26;

const TRACE_BACK_SECONDS = 4 * 60;
const TRACE_FORWARD_SECONDS = 8 * 60;
const TRACE_STEP_SECONDS = 30;

const TRACE_INTERVAL_MS = 500;

export interface SkyHudState {
  compass: ShallowRef<TapeTick[]>;
  elevation: ShallowRef<TapeTick[]>;
  locked: ShallowRef<SkyTarget | undefined>;
  /** An SVG path for the locked satellite's track, or "" when there is none. */
  trace: ShallowRef<string>;
  /** Whether the compass knows where north is. Polled, because it latches inside the sensor callback. */
  calibrated: ShallowRef<boolean>;
  /** Whether the camera has finished flying in. During the flight the aim is the destination, so the overlay stays hidden. */
  settled: ShallowRef<boolean>;
}

/** Drops ticks that would overprint their neighbours. Majors win, and the first of a cluster wins, so survivors do not flicker. */
function thin(ticks: TapeTick[]): TapeTick[] {
  const kept: TapeTick[] = [];
  for (const tick of ticks.toSorted((a, b) => Number(b.major) - Number(a.major))) {
    if (kept.every((other) => Math.abs(other.offset - tick.offset) >= MIN_TICK_SPACING)) {
      kept.push(tick);
    }
  }
  return kept.toSorted((a, b) => a.offset - b.offset);
}

export function useSkyHud(cc: CesiumController): SkyHudState & { start: () => void; stop: () => void } {
  const compass = shallowRef<TapeTick[]>([]);
  const elevation = shallowRef<TapeTick[]>([]);
  const locked = shallowRef<SkyTarget | undefined>(undefined);
  const trace = shallowRef("");
  const calibrated = shallowRef(false);
  const settled = shallowRef(false);

  let removePreRender: (() => void) | undefined;
  let sampledAt = 0;
  let sampledFor = "";
  // World positions, not window coordinates: a cached screen path detaches when the camera moves.
  // `hidden` depends on terrain, not the camera, so it is cached too.
  let samples: { position: Cartesian3; hidden: boolean }[] = [];

  function refresh(time: JulianDate): void {
    const { viewer, skyView, skyInteraction } = cc;
    const { scene } = viewer;
    const frame = skyView.frame;
    settled.value = skyView.settled;
    // `settled`, not `active`: during the descent the tapes would swim behind the fade.
    if (!skyView.settled || !frame) {
      return;
    }

    const { azimuth: viewAzimuth, pitch: viewPitch } = skyView.aim;
    const { clientWidth, clientHeight } = scene.canvas;
    const aspectRatio = clientHeight > 0 ? clientWidth / clientHeight : 1;
    const verticalSpan = skyView.fovy;
    const horizontalSpan = CesiumMath.toDegrees(fovxFromFovy(CesiumMath.toRadians(verticalSpan), aspectRatio));

    // The compass tape is a heading readout, not a horizon projection. Projecting grows the
    // scale as 1/cos(pitch) (147px to 1691px per 15° on a 390px phone at 85° pitch), and
    // registration only holds while `pitch < fovy/2` (ADR 0003). Above the horizon a tick
    // no longer sits over the true bearing; the locked target's card shows the azimuth.
    const tanHalfSpan = Math.tan(CesiumMath.toRadians(horizontalSpan) / 2);
    const halfWidth = clientWidth / 2;
    const compassStep = stepFor(horizontalSpan);
    const compassMajor = majorStep(compassStep);
    const compassTicks: TapeTick[] = [];
    const azimuthHalf = horizontalSpan / 2 + compassStep;
    const firstAzimuth = Math.ceil((viewAzimuth - azimuthHalf) / compassStep) * compassStep;
    for (let azimuth = firstAzimuth; azimuth <= viewAzimuth + azimuthHalf; azimuth += compassStep) {
      const offset = azimuth - viewAzimuth;
      // A quarter turn away is at infinity and beyond it is behind the viewer.
      if (Math.abs(offset) >= 90) {
        continue;
      }
      const value = normalizeAzimuth(azimuth);
      const major = value % compassMajor === 0 || value % 45 === 0;
      // Numeric between compass points: at a fine step the nearest cardinal is often off screen.
      compassTicks.push({
        value,
        offset: headingOffset(offset, halfWidth, tanHalfSpan),
        label: major ? (value % 45 === 0 ? compassPoint(value) : `${value}°`) : undefined,
        major,
      });
    }
    compass.value = thin(compassTicks);

    const elevationStep = stepFor(verticalSpan);
    const elevationMajor = majorStep(elevationStep);
    const elevationTicks: TapeTick[] = [];
    const elevationHalf = verticalSpan / 2 + elevationStep;
    const firstElevation = Math.max(-90, Math.ceil((viewPitch - elevationHalf) / elevationStep) * elevationStep);
    for (let angle = firstElevation; angle <= Math.min(90, viewPitch + elevationHalf); angle += elevationStep) {
      const window = directionToWindow(scene, frame, viewAzimuth, angle);
      if (!window) {
        continue;
      }
      elevationTicks.push({ value: angle, offset: window.y, label: `${angle}°`, major: angle % elevationMajor === 0 });
    }
    elevation.value = thin(elevationTicks);

    locked.value = skyInteraction.locked;
    calibrated.value = skyInteraction.compass.calibrated;
    sampleTrace(time, scene, frame);
    trace.value = projectTrace(scene);
  }

  /** At most every TRACE_INTERVAL_MS. */
  function sampleTrace(time: JulianDate, scene: Scene, frame: ObserverFrame): void {
    const target = locked.value;
    if (!target) {
      samples = [];
      sampledFor = "";
      return;
    }
    const now = performance.now();
    if (target.name === sampledFor && now - sampledAt < TRACE_INTERVAL_MS) {
      return;
    }
    sampledAt = now;
    sampledFor = target.name;

    const at = new JulianDate();
    samples = [];
    for (let offset = -TRACE_BACK_SECONDS; offset <= TRACE_FORWARD_SECONDS; offset += TRACE_STEP_SECONDS) {
      JulianDate.addSeconds(time, offset, at);
      const position = target.sat.props.trajectory.position(at);
      if (position) {
        samples.push({ position, hidden: lookAngles(frame, position).elevation <= 0 || groundHides(scene, frame, position) });
      }
    }
  }

  function projectTrace(scene: Scene): string {
    // Separate runs, so a track that goes behind the ground is not joined through it.
    const runs: string[] = [];
    let current: string[] = [];
    for (const { position, hidden } of samples) {
      const window = hidden ? undefined : SceneTransforms.worldToWindowCoordinates(scene, position);
      if (!window) {
        if (current.length > 1) {
          runs.push(current.join(" "));
        }
        current = [];
        continue;
      }
      current.push(`${current.length === 0 ? "M" : "L"}${window.x.toFixed(1)},${window.y.toFixed(1)}`);
    }
    if (current.length > 1) {
      runs.push(current.join(" "));
    }
    return runs.join(" ");
  }

  return {
    compass,
    elevation,
    locked,
    trace,
    calibrated,
    settled,
    start(): void {
      if (removePreRender) {
        return;
      }
      removePreRender = cc.viewer.scene.preRender.addEventListener((_scene, time: JulianDate) => refresh(time));
    },
    stop(): void {
      removePreRender?.();
      removePreRender = undefined;
      compass.value = [];
      elevation.value = [];
      locked.value = undefined;
      trace.value = "";
      calibrated.value = false;
      settled.value = false;
    },
  };
}
