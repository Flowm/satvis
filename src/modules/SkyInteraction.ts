// Looking around the sky view, and identifying what the crosshair is on.
//
// Pointer listeners go on the Cesium canvas, not a full-screen overlay: `#app` paints
// over `#cesiumContainer` and isolates its stacking context, so an overlay inside it
// would cover Cesium's credits and no z-index could lift them back. What a gesture
// means lives in ./skyGestures, aiming by compass in ./DeviceAim, walking in ./SkyMovement.

import { Cartesian2, type JulianDate } from "@cesium/core";
import { Entity, type Scene, type ScreenSpaceEventHandler, ScreenSpaceEventType } from "@cesium/engine";

import type { SkyAppearance } from "./componentKinds";
import { browserOrientationEvents, CompassAiming } from "./DeviceAim";
import type { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import type { SatelliteManager } from "./SatelliteManager";
import type { Observer } from "./skyGeometry";
import { type GestureIntent, lookAfterDrag, SkyGestures } from "./skyGestures";
import { SkyMovement } from "./SkyMovement";
import { groundHides, nearestTarget, type SkyTarget, skyTargets } from "./SkyTargets";
import type { SkyView } from "./SkyView";
import type { UnseenMode } from "./util/visibility";

/** In CSS pixels. */
export const CAPTURE_RADIUS = 60;

/** A fingertip around a touch, in CSS pixels: the iOS app's `Picking.pointReach`. */
const TOUCH_REACH = 24;

const VIEWER_PICK_INPUTS = [ScreenSpaceEventType.LEFT_CLICK, ScreenSpaceEventType.LEFT_DOUBLE_CLICK];

export interface SkyInteractionOptions {
  scene: Scene;
  skyView: SkyView;
  sats: SatelliteManager;
  /**
   * The viewer's, whose click selects what is under the pointer and whose double-click
   * tracks it. Both are off while this runs: a tap that misses keeps the selection, and
   * the sky view tracks nothing (docs/adr/0003-sky-view.md).
   */
  viewerInputs?: ScreenSpaceEventHandler;
  /** A tap on an entity, or the lock's card. */
  onSelect?: (entity: Entity) => void;
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

  readonly aiming: CompassAiming;

  #observerMoved: ((observer: Observer) => void) | undefined;

  constructor(options: SkyInteractionOptions) {
    this.#options = options;
    this.aiming = new CompassAiming({ events: browserOrientationEvents(), look: (aim) => options.skyView.look(aim) });
    this.#gestures = new SkyGestures({ fovy: () => options.skyView.fovy, aimHeld: () => this.aiming.active });
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

  /** Refreshed each frame. */
  get targets(): readonly SkyTarget[] {
    return this.#targets;
  }

  get locked(): SkyTarget | undefined {
    return this.#locked;
  }

  /** Opens what the crosshair holds: the lock's card was tapped. */
  selectLocked(): void {
    const entity = this.#locked?.sat.defaultEntity;
    if (entity) {
      this.#options.onSelect?.(entity);
    }
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
    // The compass can be switched on during the entry flight, before `start`.
    this.aiming.disable();
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
    this.#removePreRender?.();
    this.#removePreRender = undefined;
    this.#gestures.reset();
    this.#targets = [];
    this.#locked = undefined;
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
    this.#locked = nearestTarget(lockable, this.#center(), CAPTURE_RADIUS, (target) => groundHides(scene, frame, target.position));
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

  /** What a gesture means, applied to the view; `tap` is where a tap lands and how far it reaches, in CSS pixels. */
  #apply(intents: GestureIntent[], tap?: { at: Cartesian2; reach: number }): void {
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
          this.aiming.disable();
          break;
        case "tap":
          if (tap) {
            this.#tap(tap.at, tap.reach);
          }
          break;
      }
    }
  }

  /**
   * The globe's own hit test, so a tap opens only the satellite or station it lands on, or
   * for a finger the one drawn nearest within `reach`. A miss leaves the selection, and so
   * does what is no entity, such as a surface model.
   */
  #tap(at: Cartesian2, reach: number): void {
    const { scene } = this.#options;
    // Cesium's pick box is in drawing-buffer pixels, and it looks outward from its middle.
    const box = reach > 0 ? Math.ceil((2 * reach * scene.drawingBufferWidth) / scene.canvas.clientWidth) : undefined;
    const picked = scene.pick(at, box, box) as { id?: unknown } | undefined;
    if (picked?.id instanceof Entity) {
      this.#options.onSelect?.(picked.id);
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
    const box = this.#canvas?.getBoundingClientRect();
    this.#canvas?.releasePointerCapture?.(event.pointerId);
    const reach = event.pointerType === "touch" ? TOUCH_REACH : 0;
    this.#apply(this.#gestures.up(event.pointerId), box && { at: new Cartesian2(event.clientX - box.left, event.clientY - box.top), reach });
  };
}
