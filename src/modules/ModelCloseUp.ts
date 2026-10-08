// One satellite's model on its own, in a second Cesium scene with no globe, for the
// info panel. The scene's east-north-up frame stands for the satellite's, as on the
// dev model viewer (src/modelViewer): X velocity, Y port, Z zenith.

import { Cartesian3, CesiumWidget, Color, DirectionalLight, HeadingPitchRange, Model, PerspectiveFrustum, Tonemapper, Transforms } from "@cesium/engine";

/** Where the model sits: 500 km above 0°N 0°E. Any point off the Earth's centre would do. */
const ANCHOR = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0, 500_000));
/** A three-quarter view from ahead, starboard and above; heading 0 looks north, at the port side. */
const HEADING = -Math.PI / 4;
/** Radians below the horizon. */
const PITCH = -0.35;
/** One turn a minute. */
const TURNTABLE_RAD_PER_MS = (2 * Math.PI) / 60_000;

/** For the light's per-frame direction. */
const scratch = new Cartesian3();

/** What the view over the scene shows: a note while loading or failed, the reset button once ready. */
export type CloseUpState = "loading" | "ready" | "failed";

/** The info panel's close-up of one model. `destroy` it, or its WebGL context outlives it. */
export class ModelCloseUp {
  /** Owns the second WebGL context. */
  readonly #widget: CesiumWidget;

  /** Re-aimed every frame from the camera. */
  readonly #light = new DirectionalLight({ direction: new Cartesian3(0, 0, -1), intensity: 2.5 });

  /** The shown model, undefined between loads. */
  #model: Model | undefined;

  /** Bumped per load, so a slow load that was superseded discards its model. */
  #generation = 0;

  /** Until the first drag or wheel; `resetView` turns it back on. */
  #turning = true;

  /** `performance.now()` at the last frame, so the turn speed is independent of the frame rate. */
  #lastTurnMs: number | undefined;

  /** Told of every state change. */
  readonly #onState: (state: CloseUpState) => void;

  /** Undo every listener `destroy` would otherwise leave on the scene and the canvas. */
  readonly #removeListeners: Array<() => void> = [];

  /** Throws when the browser gives it no WebGL context. */
  constructor(container: HTMLElement, onState: (state: CloseUpState) => void) {
    this.#onState = onState;
    this.#widget = new CesiumWidget(container, {
      baseLayer: false,
      globe: false,
      skyBox: false,
      skyAtmosphere: false,
      requestRenderMode: true,
      // At the display's own ratio: Cesium's default draws CSS pixels, which blurs on HiDPI, and this canvas is small.
      useBrowserRecommendedResolution: false,
      // The main viewer already shows Cesium's credit, and this scene loads nothing that needs one.
      creditContainer: document.createElement("div"),
      contextOptions: { webgl: { alpha: true } },
      // Cesium's error panel would land inside the info panel; the view shows its own note.
      showRenderLoopErrors: false,
    });
    const { scene, camera } = this.#widget;
    scene.backgroundColor = Color.TRANSPARENT;
    scene.highDynamicRange = true;
    scene.postProcessStages.tonemapper = Tonemapper.ACES;
    scene.light = this.#light;
    // Cubesats are 10 cm across; Cesium's defaults stop the camera a metre short.
    (camera.frustum as PerspectiveFrustum).near = 0.001;

    this.#removeListeners.push(scene.preUpdate.addEventListener(() => this.#turn()));
    // Cesium swallows a render error and raises this each frame, so the view would otherwise sit blank.
    this.#removeListeners.push(scene.renderError.addEventListener(() => this.#onState("failed")));
    // A studio light, kept over the viewer's left shoulder: space has no fill, and a fixed sun leaves the far side black.
    this.#removeListeners.push(
      scene.preRender.addEventListener(() => {
        const { directionWC, rightWC, upWC } = camera;
        const direction = this.#light.direction;
        Cartesian3.clone(directionWC, direction);
        Cartesian3.add(direction, Cartesian3.multiplyByScalar(rightWC, 0.5, scratch), direction);
        Cartesian3.add(direction, Cartesian3.multiplyByScalar(upWC, -0.7, scratch), direction);
        Cartesian3.normalize(direction, direction);
      }),
    );

    const stop = (): void => {
      this.#turning = false;
    };
    const { canvas } = scene;
    canvas.addEventListener("pointerdown", stop);
    canvas.addEventListener("wheel", stop, { passive: true });
    this.#removeListeners.push(() => {
      canvas.removeEventListener("pointerdown", stop);
      canvas.removeEventListener("wheel", stop);
    });
  }

  /** Replaces the shown model; `url` as `modelUrl` gives it. */
  async load(url: string): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    this.#dropModel();
    this.#onState("loading");
    try {
      const model = await Model.fromGltfAsync({ url, modelMatrix: ANCHOR });
      if (generation !== this.#generation || this.#widget.isDestroyed()) {
        model.destroy();
        return;
      }
      this.#model = this.#widget.scene.primitives.add(model) as Model;
      model.readyEvent.addEventListener(() => {
        if (generation === this.#generation) {
          this.resetView();
          this.#onState("ready");
        }
      });
      // A texture can fail after the model is drawn; that leaves a usable model, not a failure.
      model.errorEvent.addEventListener(() => {
        if (generation === this.#generation && !model.ready) {
          this.#onState("failed");
        }
      });
    } catch {
      if (generation === this.#generation) {
        this.#onState("failed");
      }
    }
  }

  /** Frames the whole model from the default angle and starts it turning again. */
  resetView(): void {
    const model = this.#model;
    if (!model?.ready) {
      return;
    }
    const { scene, camera } = this.#widget;
    const sphere = model.boundingSphere;
    const frustum = camera.frustum as PerspectiveFrustum;
    const fovy = frustum.fovy ?? Math.PI / 3;
    const fovx = 2 * Math.atan(Math.tan(fovy / 2) * (frustum.aspectRatio || 1));
    // 0.85 of what fits the bounding sphere: models are rarely round, and the sphere left the ISS a third of the view.
    const range = (sphere.radius / Math.sin(Math.min(fovx, fovy) / 2)) * 0.85;
    // Pinned to the sphere's centre, so dragging orbits the model rather than the Earth.
    camera.lookAtTransform(Transforms.eastNorthUpToFixedFrame(sphere.center), new HeadingPitchRange(HEADING, PITCH, range));
    const controller = scene.screenSpaceCameraController;
    controller.minimumZoomDistance = sphere.radius * 0.6;
    controller.maximumZoomDistance = range * 4;
    this.#turning = true;
    this.#lastTurnMs = undefined;
    scene.requestRender();
  }

  /** One frame's share of the turntable, while it runs. */
  #turn(): void {
    const now = performance.now();
    if (this.#turning && this.#model?.ready && this.#lastTurnMs !== undefined) {
      // With a transform set, Cesium turns the camera about the constrained axis, the frame's zenith.
      this.#widget.camera.rotateLeft((now - this.#lastTurnMs) * TURNTABLE_RAD_PER_MS);
      this.#widget.scene.requestRender();
    }
    this.#lastTurnMs = now;
  }

  /** `primitives.remove` also destroys it. */
  #dropModel(): void {
    if (this.#model) {
      this.#widget.scene.primitives.remove(this.#model);
      this.#model = undefined;
    }
  }

  /**
   * Also loses the WebGL context: Cesium does not, and a browser that runs out of
   * contexts drops its oldest one, the globe's.
   */
  destroy(): void {
    this.#generation += 1;
    this.#removeListeners.forEach((remove) => remove());
    const { canvas } = this.#widget;
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    this.#widget.destroy();
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
