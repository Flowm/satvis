// One satellite's model on its own, in a second Cesium scene with no globe, for the
// info panel. The scene's east-north-up frame stands for the satellite's, as on the
// dev model viewer (src/modelViewer): X velocity, Y port, Z zenith.

import { Cartesian3, CesiumWidget, Color, DirectionalLight, HeadingPitchRange, Model, PerspectiveFrustum, ScreenSpaceEventType, Tonemapper, Transforms } from "@cesium/engine";

/** Where the model sits: 500 km above 0°N 0°E. Any point off the Earth's centre would do. */
const ANCHOR = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(0, 0, 500_000));
/** A three-quarter view from ahead, starboard and above; heading 0 looks north, at the port side. */
const HEADING = -Math.PI / 4;
const PITCH = -0.35;
/** One turn a minute. */
const TURNTABLE_RAD_PER_MS = (2 * Math.PI) / 60_000;

const scratch = new Cartesian3();

export type CloseUpState = "loading" | "ready" | "failed";

/** A model, framed and turning until the user takes the camera. */
export class ModelCloseUp {
  readonly #widget: CesiumWidget;

  readonly #light = new DirectionalLight({ direction: new Cartesian3(0, 0, -1), intensity: 2.5 });

  #model: Model | undefined;

  /** Bumped per load, so a slow load that was superseded discards its model. */
  #generation = 0;

  #turning = true;

  #lastTurnMs: number | undefined;

  readonly #onState: (state: CloseUpState) => void;

  readonly #removeListeners: Array<() => void> = [];

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
    });
    const { scene, camera } = this.#widget;
    scene.backgroundColor = Color.TRANSPARENT;
    // As the main viewer renders models (createViewer.ts).
    scene.highDynamicRange = true;
    scene.postProcessStages.tonemapper = Tonemapper.ACES;
    scene.light = this.#light;
    // Cubesats are 10 cm across; Cesium's defaults stop the camera a metre short.
    (camera.frustum as PerspectiveFrustum).near = 0.001;
    // Built-in double-click flies to an entity; there are none.
    this.#widget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    this.#removeListeners.push(scene.preUpdate.addEventListener(() => this.#turn()));
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
      model.errorEvent.addEventListener(() => {
        if (generation === this.#generation) {
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

  #turn(): void {
    const now = performance.now();
    if (this.#turning && this.#model?.ready && this.#lastTurnMs !== undefined) {
      // With a transform set, Cesium turns the camera about the constrained axis, the frame's zenith.
      this.#widget.camera.rotateLeft((now - this.#lastTurnMs) * TURNTABLE_RAD_PER_MS);
      this.#widget.scene.requestRender();
    }
    this.#lastTurnMs = now;
  }

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
