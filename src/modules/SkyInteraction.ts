// Looking around the sky view, and identifying what the crosshair is on.
//
// Pointer listeners go on the Cesium canvas, not a full-screen overlay:
// `#app` isolates its stacking context, so no overlay can sit above Cesium's
// clock, timeline and credits without swallowing their clicks. Walking lives in
// ./SkyMovement.

import { Cartesian2, type JulianDate, type Scene } from "@cesium/engine";

import { aimFromDeviceOrientation, CompassCalibration, hasHeadingSource } from "./DeviceAim";
import type { SatelliteManager } from "./SatelliteManager";
import { SkyMovement } from "./SkyMovement";
import { groundHides, nearestTarget, type SkyTarget, skyTargets } from "./SkyTargets";
import type { Observer, SkyView } from "./SkyView";

// iOS gates the sensor behind a call from a user gesture, over https only. Not in lib.dom.
interface DeviceOrientationPermission {
  requestPermission?: () => Promise<"granted" | "denied" | "prompt">;
}

/** Safari only. */
interface CompassEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

/** A laptop, a declined permission and a missing magnetometer each need different words. See docs/adr/0004-compass-aiming.md. */
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

/** In CSS pixels. */
export const CAPTURE_RADIUS = 60;

/** A drag this small (CSS pixels) is a tap: it absorbs tremor but not a short flick. */
const TAP_SLOP = 8;

/** Multiplicative, so equal gestures give equal zoom rather than equal degrees. */
const WHEEL_ZOOM_RATE = 0.0015;

/** `deltaMode` 1 is lines and 2 is pages; normalise to pixels. */
const WHEEL_DELTA_SCALE: Record<number, number> = { 1: 16, 2: 100 };

const SENSOR_PROBE_MS = 1200;

export interface SkyInteractionOptions {
  scene: Scene;
  skyView: SkyView;
  sats: SatelliteManager;
  /** Also called when the lock clears. */
  onLockChange?: (target: SkyTarget | undefined) => void;
  onSelect?: (target: SkyTarget) => void;
}

export class SkyInteraction {
  #options: SkyInteractionOptions;

  #canvas: HTMLCanvasElement | undefined;

  #removePreRender: (() => void) | undefined;

  #pointerId: number | undefined;

  /** In CSS pixels. */
  #dragged = 0;

  /** Separate from `#dragged`: a pinch is not a tap, though its fingers may not have dragged. */
  #pinched = false;

  #last = new Cartesian2();

  #pointers = new Map<number, Cartesian2>();

  /** Latched at the pinch start: accumulating per-move ratios drifts over a long gesture. */
  #pinch: { startDistance: number; startFovy: number } | undefined;

  #targets: SkyTarget[] = [];

  #locked: SkyTarget | undefined;

  readonly compass = new CompassCalibration();

  readonly movement: SkyMovement;

  #observerMoved: ((observer: Observer) => void) | undefined;

  #orientationStopped: (() => void) | undefined;

  #orientationActive = false;

  #sawOrientation = false;

  #sawHeadingSource = false;

  constructor(options: SkyInteractionOptions) {
    this.#options = options;
    this.movement = new SkyMovement({
      skyView: options.skyView,
      onMove: (observer) => this.#observerMoved?.(observer),
    });
  }

  /**
   * Called when a walk comes to rest somewhere new. A registration, not an option:
   * the store is sceneSync's to write, as with `sats.onTrackedChange`.
   */
  onObserverMove(callback: (observer: Observer) => void): void {
    this.#observerMoved = callback;
  }

  get orientationActive(): boolean {
    return this.#orientationActive;
  }

  /**
   * Must be called from a user gesture (iOS permission prompt, secure context
   * only). `deviceorientationabsolute` is the only source of north on Android;
   * `deviceorientation` carries `webkitCompassHeading` on iOS.
   */
  async enableDeviceOrientation(): Promise<CompassOutcome> {
    if (this.#orientationActive) {
      return this.compass.calibrated ? "aiming" : "aiming-uncalibrated";
    }
    if (typeof DeviceOrientationEvent === "undefined") {
      return "unsupported";
    }
    const gate = DeviceOrientationEvent as unknown as DeviceOrientationPermission;
    if (typeof gate.requestPermission === "function") {
      try {
        if ((await gate.requestPermission()) !== "granted") {
          return "denied";
        }
      } catch {
        // Thrown outside a gesture.
        return "denied";
      }
    }
    window.addEventListener("deviceorientationabsolute", this.#onDeviceOrientation);
    window.addEventListener("deviceorientation", this.#onDeviceOrientation);
    this.#orientationActive = true;

    // Desktop browsers grant the event and never fire it, which would freeze the
    // view, so the sensor has to prove itself.
    this.#sawOrientation = false;
    this.#sawHeadingSource = false;
    await new Promise((resolve) => setTimeout(resolve, SENSOR_PROBE_MS));
    // A drag can take the aim back during the probe; report what is in force.
    if (!this.#orientationActive) {
      return "taken-back";
    }
    if (!this.#sawOrientation) {
      this.disableDeviceOrientation();
      return "silent";
    }
    // Without north, the azimuth would be measured from wherever the device happened to point.
    if (!this.#sawHeadingSource) {
      this.disableDeviceOrientation();
      return "no-heading";
    }
    return this.compass.calibrated ? "aiming" : "aiming-uncalibrated";
  }

  /**
   * Levels the view on the way out: only the sensor rolls it, so a leftover roll
   * is one the pointer cannot straighten.
   */
  disableDeviceOrientation(): void {
    if (!this.#orientationActive) {
      return;
    }
    window.removeEventListener("deviceorientationabsolute", this.#onDeviceOrientation);
    window.removeEventListener("deviceorientation", this.#onDeviceOrientation);
    this.#orientationActive = false;
    this.#options.skyView.look({ roll: 0 });
    this.#orientationStopped?.();
  }

  /** Also called when a drag takes the aim back, which the compass control cannot otherwise see. */
  onOrientationStop(callback: () => void): void {
    this.#orientationStopped = callback;
  }

  #onDeviceOrientation = (event: DeviceOrientationEvent): void => {
    const { alpha, beta, gamma } = event;
    if (alpha === null || beta === null || gamma === null) {
      return;
    }
    this.#sawOrientation = true;
    const sample = { alpha, beta, gamma, screenAngle: screen.orientation?.angle ?? 0 };
    // `deviceorientation` sets `absolute` false too; that says nothing about iOS's heading.
    const reading = {
      compassHeading: (event as CompassEvent).webkitCompassHeading,
      absolute: event.type === "deviceorientationabsolute" && event.absolute,
    };
    this.#sawHeadingSource ||= hasHeadingSource(reading);
    // The compass is a yaw offset about world up, never folded into alpha; see DeviceAim.
    this.compass.update(sample, reading);
    this.#options.skyView.look(this.compass.correct(aimFromDeviceOrientation(sample)));
  };

  /** Refreshed each frame. */
  get targets(): readonly SkyTarget[] {
    return this.#targets;
  }

  get locked(): SkyTarget | undefined {
    return this.#locked;
  }

  start(): void {
    if (this.#canvas) {
      return;
    }
    const { scene } = this.#options;
    this.#canvas = scene.canvas;
    this.#canvas.addEventListener("pointerdown", this.#onPointerDown);
    this.#canvas.addEventListener("pointermove", this.#onPointerMove);
    this.#canvas.addEventListener("pointerup", this.#onPointerUp);
    this.#canvas.addEventListener("pointercancel", this.#onPointerUp);
    // Not passive: the wheel zooms, so the page must not scroll.
    this.#canvas.addEventListener("wheel", this.#onWheel, { passive: false });
    this.movement.start();
    this.#removePreRender = scene.preRender.addEventListener((_scene: Scene, time: JulianDate) => {
      this.movement.step(performance.now());
      this.#refresh(time);
    });
  }

  stop(): void {
    if (!this.#canvas) {
      return;
    }
    this.#canvas.removeEventListener("pointerdown", this.#onPointerDown);
    this.#canvas.removeEventListener("pointermove", this.#onPointerMove);
    this.#canvas.removeEventListener("pointerup", this.#onPointerUp);
    this.#canvas.removeEventListener("pointercancel", this.#onPointerUp);
    this.#canvas.removeEventListener("wheel", this.#onWheel);
    this.#canvas = undefined;
    this.movement.stop();
    this.disableDeviceOrientation();
    this.#removePreRender?.();
    this.#removePreRender = undefined;
    this.#pointerId = undefined;
    this.#pointers.clear();
    this.#pinch = undefined;
    this.#targets = [];
    this.#setLocked(undefined);
  }

  /** In CSS pixels. */
  #center(): Cartesian2 {
    const { canvas } = this.#options.scene;
    return new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  }

  #refresh(time: JulianDate): void {
    const { scene, skyView, sats } = this.#options;
    const frame = skyView.frame;
    if (!skyView.active || !frame) {
      return;
    }
    this.#targets = skyTargets(scene, frame, sats.activeSatellites, time);
    // The picture already hides what the ground hides.
    this.#setLocked(nearestTarget(this.#targets, this.#center(), CAPTURE_RADIUS, (target) => groundHides(scene, frame, target.position)));
  }

  #setLocked(target: SkyTarget | undefined): void {
    // Compare by satellite: the target is rebuilt every frame.
    if (this.#locked?.sat === target?.sat) {
      this.#locked = target;
      return;
    }
    this.#locked = target;
    this.#options.onLockChange?.(target);
  }

  #zoomBy(factor: number): void {
    const { skyView } = this.#options;
    if (!skyView.active) {
      return;
    }
    skyView.fovy *= factor;
  }

  /**
   * Zooms about the crosshair, not the cursor: under device orientation the next
   * reading overwrites the aim, so zoom-to-cursor would snap back.
   */
  #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const pixels = event.deltaY * (WHEEL_DELTA_SCALE[event.deltaMode] ?? 1);
    // Scrolling down widens the field of view.
    this.#zoomBy(Math.exp(pixels * WHEEL_ZOOM_RATE));
  };

  #pinchDistance(): number | undefined {
    const [first, second] = [...this.#pointers.values()];
    return first && second ? Cartesian2.distance(first, second) : undefined;
  }

  #onPointerDown = (event: PointerEvent): void => {
    this.#pointers.set(event.pointerId, new Cartesian2(event.clientX, event.clientY));
    this.#canvas?.setPointerCapture(event.pointerId);

    if (this.#pointers.size === 2) {
      // A gesture is a drag or a pinch: zoom changes only the field of view.
      this.#pointerId = undefined;
      this.#pinched = true;
      this.#pinch = { startDistance: this.#pinchDistance() ?? 1, startFovy: this.#options.skyView.fovy };
      return;
    }
    if (this.#pointers.size === 1) {
      this.#pointerId = event.pointerId;
      this.#dragged = 0;
      this.#pinched = false;
      this.#last = new Cartesian2(event.clientX, event.clientY);
    }
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (!this.#pointers.has(event.pointerId)) {
      return;
    }
    this.#pointers.set(event.pointerId, new Cartesian2(event.clientX, event.clientY));

    if (this.#pinch) {
      const distance = this.#pinchDistance();
      if (distance !== undefined && distance > 0) {
        // Twist is ignored: only the device sensor rolls the view.
        this.#options.skyView.fovy = (this.#pinch.startFovy * this.#pinch.startDistance) / distance;
      }
      return;
    }

    if (event.pointerId !== this.#pointerId) {
      return;
    }
    const dx = event.clientX - this.#last.x;
    const dy = event.clientY - this.#last.y;
    this.#last = new Cartesian2(event.clientX, event.clientY);
    this.#dragged += Math.abs(dx) + Math.abs(dy);

    // A drag takes the aim back from the device; otherwise the next reading would
    // spring the sky back. Only past the tap slop, so a tap can still select. A
    // pinch's remaining finger restarts `#dragged`, so it must travel too. Walking
    // never touches the aim and leaves the compass on.
    if (this.#orientationActive) {
      if (this.#dragged <= TAP_SLOP) {
        return;
      }
      this.disableDeviceOrientation();
    }

    // Degrees per pixel from the vertical field of view, so the sky tracks the cursor at any zoom.
    const { skyView, scene } = this.#options;
    const height = scene.canvas.clientHeight || 1;
    const perPixel = skyView.fovy / height;
    const { azimuth, pitch } = skyView.aim;
    skyView.look({
      azimuth: azimuth - dx * perPixel,
      // Clamped, not wrapped: passing the zenith would flip the azimuth and the roll.
      pitch: Math.min(90, Math.max(-90, pitch + dy * perPixel)),
    });
  };

  #onPointerUp = (event: PointerEvent): void => {
    const tracked = this.#pointers.delete(event.pointerId);
    this.#canvas?.releasePointerCapture?.(event.pointerId);
    if (!tracked) {
      return;
    }

    if (this.#pinch) {
      if (this.#pointers.size >= 2) {
        return;
      }
      this.#pinch = undefined;
      const [remaining] = [...this.#pointers.entries()];
      if (remaining) {
        // Re-seeded, not resumed: the finger moved while pinching. `#pinched`
        // remembers this was no tap.
        this.#pointerId = remaining[0];
        this.#last = remaining[1];
        this.#dragged = 0;
      }
      return;
    }

    if (event.pointerId !== this.#pointerId) {
      return;
    }
    this.#pointerId = undefined;
    if (this.#dragged > TAP_SLOP || this.#pinched) {
      return;
    }
    // A tap selects what the crosshair is on, not what is under the finger.
    if (this.#locked) {
      this.#options.onSelect?.(this.#locked);
    }
  };
}
