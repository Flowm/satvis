// Many satellites' orbit lines merged into one Primitive, because thousands of
// polylines are thousands of draw calls. It rebuilds asynchronously when the set
// changes; do not morph the scene while a build is in flight (see `settled()`).
//
// - "inertial" (the Orbit component): the ellipse is fixed in inertial space, so a
//   model matrix re-orients the primitive and only membership changes rebuild it.
// - "fixed" (the Orbit track component): an Earth-relative track is no rigid
//   transform of itself, so the owner swaps geometry through `replace` and the
//   coalescing window folds those swaps into one rebuild.

import { type GeometryInstance, type JulianDate, Matrix4, defined } from "@cesium/core";
import { PolylineColorAppearance, Primitive, SceneMode, Transforms } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import { CesiumCallbackHelper } from "./CesiumCallbackHelper";
import { driveBuild } from "./driveBuild";

/** Ticks to coalesce over, so a hundred satellites arriving cost one rebuild. */
const COALESCE_TICKS = 30;

/** How often the batch is re-oriented into the inertial frame. */
const FRAME_UPDATE_SECONDS = 0.5;

export type BatchFrame = "inertial" | "fixed";

export class PolylineBatch {
  #viewer: Viewer;

  readonly #frame: BatchFrame;

  #geometries: GeometryInstance[] = [];

  #primitive: Primitive | undefined;

  /** A rebuild is queued and waiting out the coalescing window. */
  #scheduled = false;

  /** A Primitive is being built and is not in the scene yet. */
  #building = false;

  #settledWaiters: Array<() => void> = [];

  constructor(viewer: Viewer, frame: BatchFrame = "inertial") {
    this.#viewer = viewer;
    this.#frame = frame;
    if (frame === "inertial") {
      // Permanent; a no-op while there is no primitive.
      CesiumCallbackHelper.createPeriodicTimeCallback(viewer, FRAME_UPDATE_SECONDS, (time) => this.#applyInertialFrame(time));
    }
  }

  get pending(): boolean {
    return this.#scheduled || this.#building;
  }

  get size(): number {
    return this.#geometries.length;
  }

  add(geometry: GeometryInstance): void {
    this.#geometries.push(geometry);
    this.#schedule();
  }

  remove(geometry: GeometryInstance): void {
    this.#geometries = this.#geometries.filter((candidate) => candidate !== geometry);
    this.#schedule();
  }

  /**
   * Returns false when `previous` is not a member (its component was disabled before
   * the refresh ran), so the caller can drop `next` instead of leaking it.
   */
  replace(previous: GeometryInstance, next: GeometryInstance): boolean {
    const index = this.#geometries.indexOf(previous);
    if (index === -1) {
      return false;
    }
    this.#geometries[index] = next;
    this.#schedule();
    return true;
  }

  /**
   * Resolves once the batch matches its geometries. The scene morph waits on it:
   * morphing first would rebuild the batch into the projection being left.
   */
  settled(): Promise<void> {
    if (!this.pending) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#settledWaiters.push(resolve);
    });
  }

  #resolveSettled(): void {
    const waiters = this.#settledWaiters;
    this.#settledWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  #schedule(): void {
    if (this.#scheduled) {
      return;
    }
    this.#scheduled = true;
    const stop = CesiumCallbackHelper.createPeriodicTickCallback(this.#viewer, COALESCE_TICKS, () => {
      // A build is in flight; try again next window.
      if (this.#building) {
        return;
      }
      stop();
      this.#scheduled = false;
      if (this.#geometries.length === 0) {
        this.#clear();
        this.#resolveSettled();
        return;
      }
      this.#build();
    });
  }

  #clear(): void {
    if (!this.#primitive) {
      return;
    }
    this.#viewer.scene.primitives.remove(this.#primitive);
    this.#primitive = undefined;
    this.#viewer.scene.requestRender();
  }

  #build(): void {
    this.#building = true;
    const primitive = new Primitive({
      geometryInstances: this.#geometries,
      appearance: new PolylineColorAppearance(),
    });

    driveBuild(this.#viewer, primitive, {
      ready: () => {
        // Oriented before it goes in, so it is never drawn a frame behind.
        this.#orient(primitive, this.#viewer.clock.currentTime);
        this.#clear();
        this.#viewer.scene.primitives.add(primitive);
        this.#primitive = primitive;
        this.#viewer.scene.requestRender();
        this.#finished();
      },
      failed: () => this.#finished(),
    });
  }

  /** The build is over, swapped in or failed. */
  #finished(): void {
    this.#building = false;
    if (!this.pending) {
      this.#resolveSettled();
    }
  }

  #applyInertialFrame(time: JulianDate): void {
    if (this.#primitive) {
      this.#orient(this.#primitive, time);
    }
  }

  /**
   * Cesium throws from the render loop on an inertial `modelMatrix` outside 3D, so
   * the identity stands in until the periodic update restores the rotation. A
   * fixed-frame batch needs no matrix.
   */
  #orient(primitive: Primitive, time: JulianDate): void {
    if (this.#frame === "fixed") {
      return;
    }
    if (this.#viewer.scene.mode !== SceneMode.SCENE3D) {
      primitive.modelMatrix = Matrix4.IDENTITY;
      return;
    }
    const icrfToFixed = Transforms.computeIcrfToFixedMatrix(time);
    if (defined(icrfToFixed)) {
      primitive.modelMatrix = Matrix4.fromRotationTranslation(icrfToFixed);
    }
  }
}
