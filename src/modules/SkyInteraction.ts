// Looking around the sky view, and identifying what the crosshair is on.
//
// Pointer listeners go on the Cesium canvas, not a full-screen overlay: `#app` paints
// over `#cesiumContainer` and isolates its stacking context, so an overlay inside it
// would cover Cesium's credits and no z-index could lift them back. What a gesture
// means lives in ./skyGestures, aiming by compass in ./DeviceAim, walking in ./SkyMovement.

import { Cartesian2, type JulianDate, type Scene, type ScreenSpaceEventHandler, ScreenSpaceEventType } from "@cesium/engine";

import type { SkyAppearance } from "./componentKinds";
import { browserOrientationEvents, CompassAiming, type CompassCalibration, type CompassOutcome } from "./DeviceAim";
import type { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import type { SatelliteManager } from "./SatelliteManager";
import { type GestureIntent, lookAfterDrag, SkyGestures } from "./skyGestures";
import { SkyMovement } from "./SkyMovement";
import { groundHides, nearestTarget, type SkyTarget, skyTargets } from "./SkyTargets";
import type { Observer, SkyView } from "./SkyView";
import type { UnseenMode } from "./util/visibility";

/** In CSS pixels. */
export const CAPTURE_RADIUS = 60;

const VIEWER_PICK_INPUTS = [ScreenSpaceEventType.LEFT_CLICK, ScreenSpaceEventType.LEFT_DOUBLE_CLICK];

export interface SkyInteractionOptions {
  scene: Scene;
  skyView: SkyView;
  sats: SatelliteManager;
  /**
   * The viewer's, whose click selects what is under the pointer and whose double-click
   * tracks it. Both are off while this runs: the sky view acts on its crosshair and
   * tracks nothing (docs/adr/0003-sky-view.md).
   */
  viewerInputs?: ScreenSpaceEventHandler;
  /** Also called when the lock clears. */
  onLockChange?: (target: SkyTarget | undefined) => void;
  onSelect?: (target: SkyTarget) => void;
}

export class SkyInteraction {
  #options: SkyInteractionOptions;

  #canvas: HTMLCanvasElement | undefined;

  #removePreRender: (() => void) | undefined;

  /** The viewer's pick actions, put back by `stop`. */
  #viewerActions: [ScreenSpaceEventType, unknown][] = [];

  readonly #gestures: SkyGestures;

  #targets: SkyTarget[] = [];

  #locked: SkyTarget | undefined;

  /** See `unseen`. */
  #unseen: UnseenMode = "dim";

  /** Every satellite given a sky appearance, so `stop` can restore them all. */
  readonly #styled = new Set<SatelliteComponentCollection>();

  readonly movement: SkyMovement;

  readonly #aiming: CompassAiming;

  #observerMoved: ((observer: Observer) => void) | undefined;

  constructor(options: SkyInteractionOptions) {
    this.#options = options;
    this.#aiming = new CompassAiming({ events: browserOrientationEvents(), look: (aim) => options.skyView.look(aim) });
    this.#gestures = new SkyGestures({ fovy: () => options.skyView.fovy, aimHeld: () => this.#aiming.active });
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
    return this.#aiming.active;
  }

  get compass(): CompassCalibration {
    return this.#aiming.calibration;
  }

  /** Must be called from a user gesture; see `CompassAiming.enable`. */
  enableDeviceOrientation(): Promise<CompassOutcome> {
    return this.#aiming.enable();
  }

  /** Levels the view; see `CompassAiming.disable`. */
  disableDeviceOrientation(): void {
    this.#aiming.disable();
  }

  /** Also called when a drag takes the aim back, which the compass control cannot otherwise see. */
  onOrientationStop(callback: () => void): void {
    this.#aiming.onStop(callback);
  }

  /** Refreshed each frame. */
  get targets(): readonly SkyTarget[] {
    return this.#targets;
  }

  get locked(): SkyTarget | undefined {
    return this.#locked;
  }

  /** What to do with the satellites that cannot be seen; hidden ones are also off the crosshair. */
  get unseen(): UnseenMode {
    return this.#unseen;
  }

  set unseen(mode: UnseenMode) {
    this.#unseen = mode;
    this.#options.scene.requestRender();
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
    const inputs = this.#options.viewerInputs;
    if (inputs) {
      this.#viewerActions = VIEWER_PICK_INPUTS.map((type) => [type, inputs.getInputAction(type)]);
      VIEWER_PICK_INPUTS.forEach((type) => inputs.removeInputAction(type));
    }
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
    for (const [type, action] of this.#viewerActions) {
      if (action) {
        this.#options.viewerInputs?.setInputAction(action as Parameters<ScreenSpaceEventHandler["setInputAction"]>[0], type);
      }
    }
    this.#viewerActions = [];
    this.movement.stop();
    this.disableDeviceOrientation();
    this.#removePreRender?.();
    this.#removePreRender = undefined;
    this.#gestures.reset();
    this.#targets = [];
    this.#setLocked(undefined);
    for (const sat of this.#styled) {
      sat.skyAppearance = "normal";
    }
    this.#styled.clear();
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
    for (const target of this.#targets) {
      target.sat.skyAppearance = this.#appearance(target);
      this.#styled.add(target.sat);
    }
    // The picture already hides what the ground hides.
    const lockable = this.#unseen === "hide" ? this.#targets.filter((target) => target.visibility === "visible") : this.#targets;
    this.#setLocked(nearestTarget(lockable, this.#center(), CAPTURE_RADIUS, (target) => groundHides(scene, frame, target.position)));
  }

  /** Daylight dims every satellite alike, so it dims less than a dark sky (`PALETTES`). */
  #appearance(target: SkyTarget): SkyAppearance {
    if (target.visibility === "visible" || this.#unseen === "show") {
      return "normal";
    }
    if (this.#unseen === "hide") {
      return "hidden";
    }
    return target.visibility === "daylight" ? "dimmedDaylight" : "dimmedDark";
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

  /** What a gesture means, applied to the view. */
  #apply(intents: GestureIntent[]): void {
    const { skyView, scene } = this.#options;
    for (const intent of intents) {
      switch (intent.kind) {
        case "look":
          skyView.look(lookAfterDrag(skyView.aim, intent.dx, intent.dy, skyView.fovy, scene.canvas.clientHeight));
          break;
        case "fovy":
          skyView.fovy = intent.fovy;
          break;
        case "zoom":
          // About the crosshair, not the cursor: under device orientation the next
          // reading overwrites the aim, so zoom-to-cursor would snap back.
          if (skyView.active) {
            skyView.fovy *= intent.factor;
          }
          break;
        case "take-aim":
          // Walking never touches the aim and leaves the compass on.
          this.disableDeviceOrientation();
          break;
        case "tap":
          if (this.#locked) {
            this.#options.onSelect?.(this.#locked);
          }
          break;
      }
    }
  }

  #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.#apply(this.#gestures.wheel(event.deltaY, event.deltaMode));
  };

  #onPointerDown = (event: PointerEvent): void => {
    this.#canvas?.setPointerCapture(event.pointerId);
    this.#apply(this.#gestures.down(event.pointerId, event.clientX, event.clientY));
  };

  #onPointerMove = (event: PointerEvent): void => {
    this.#apply(this.#gestures.move(event.pointerId, event.clientX, event.clientY));
  };

  #onPointerUp = (event: PointerEvent): void => {
    this.#canvas?.releasePointerCapture?.(event.pointerId);
    this.#apply(this.#gestures.up(event.pointerId));
  };
}
