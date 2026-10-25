// Every satellite's ground track in one Primitive, whose shader draws only the stretch
// from the clock to LEAD_SECONDS ahead. The clip follows the clock every frame; the
// ribbons are cut anew only as the clock nears their ends, so a rebuild in flight never
// shows. Re-cutting ground-clamped corridors instead left the track 50-150 km behind
// the satellite at x100: Cesium rebuilt them in workers, frames behind the clock.

import { Color, GeometryInstance, JulianDate, TimeInterval } from "@cesium/core";
import { Appearance, BlendingState, Material, Primitive } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type { SampledTrajectory } from "../SampledTrajectory";
import { CesiumCallbackHelper } from "./CesiumCallbackHelper";
import { driveBuild } from "./driveBuild";
import { groundTrackRibbon, type RibbonSwath, TRACK_SECONDS_ATTRIBUTE } from "./groundTrackRibbon";

/** How far ahead of the satellite its ground track reaches. Simulation seconds. */
export const LEAD_SECONDS = 300;

/** Ticks to coalesce over, so a hundred satellites arriving cost one rebuild. */
const COALESCE_TICKS = 30;

/**
 * Simulation seconds a cut reaches past the drawn stretch, either way. Within the
 * trajectory's window: a refill every quarter orbit keeps 1,320 s behind at 88 minutes.
 */
const MIN_REACH_SECONDS = 600;
const MAX_REACH_SECONDS = 1200;

/** Wall seconds of clock a cut should outlast, so a fast clock cuts farther. */
const REACH_WALL_SECONDS = 2;

/** The share of the reach the clock may cover before the next cut; the rest is for the build. */
const RECUT_SHARE = 1 / 3;

const COLOR = Color.DARKRED.withAlpha(0.25);

const VERTEX_SHADER = `
in vec3 position3DHigh;
in vec3 position3DLow;
in float ${TRACK_SECONDS_ATTRIBUTE};
in float batchId;

out float v_trackSeconds;

void main()
{
    vec4 p = czm_computePosition();
    v_trackSeconds = ${TRACK_SECONDS_ATTRIBUTE};
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;

const FRAGMENT_SHADER = `
in float v_trackSeconds;

void main()
{
    if (!groundTrackShows(v_trackSeconds)) {
        discard;
    }
    out_FragColor = czm_gammaCorrect(groundTrackColor());
}
`;

/**
 * Prepended to the fragment shader. Material uniforms are renamed per material, so the
 * shader reaches them only through functions declared here.
 */
const MATERIAL_SOURCE = `
bool groundTrackShows(float trackSeconds)
{
    float ahead = trackSeconds - clockSeconds;
    return ahead >= 0.0 && ahead <= ${LEAD_SECONDS.toFixed(1)};
}

vec4 groundTrackColor()
{
    return trackColor;
}
`;

/** The module behind `passThroughWorkerPath`. */
let passThroughWorker: string | undefined;

/**
 * A module for Cesium's geometry workers that hands a geometry back as it came. Cesium
 * builds only geometry that names a worker module asynchronously, and a ribbon is made
 * already; with one, the combine, the 2D projection and the antimeridian split leave
 * the main thread. A rebuild of 651 ribbons then cost 1.6 ms there after its 18 ms cut,
 * against 28 ms more built synchronously.
 */
function passThroughWorkerPath(): string {
  passThroughWorker ??= URL.createObjectURL(new Blob(["export default function (geometry) { return geometry; }"], { type: "text/javascript" }));
  return passThroughWorker;
}

/** Simulation seconds a cut reaches past the drawn stretch at this clock multiplier. */
export function reachSeconds(multiplier: number): number {
  return Math.min(MAX_REACH_SECONDS, Math.max(MIN_REACH_SECONDS, Math.abs(multiplier) * REACH_WALL_SECONDS));
}

/** One satellite's ground track: the component the "Ground track" kind hands its collection. */
export class GroundTrack {
  readonly id: string;

  readonly #trajectory: SampledTrajectory;

  readonly #swath: RibbonSwath;

  /** Whether the last cut found samples over all of its reach; a refill re-cuts only one that did not. */
  complete = false;

  constructor(id: string, trajectory: SampledTrajectory, swath: RibbonSwath) {
    this.id = id;
    this.#trajectory = trajectory;
    this.#swath = swath;
  }

  /** The vertex times count from `time`. */
  cut(time: JulianDate, reach: number): GeometryInstance | undefined {
    const start = JulianDate.addSeconds(time, -reach, new JulianDate());
    const stop = JulianDate.addSeconds(time, LEAD_SECONDS + reach, new JulianDate());
    const interval = this.#trajectory.interval;
    this.complete = interval !== undefined && TimeInterval.contains(interval, start) && TimeInterval.contains(interval, stop);
    const { times, positions } = this.#trajectory.samplesBetween(start, stop);
    const seconds = times.map((sampleTime) => JulianDate.secondsDifference(sampleTime, time));
    const geometry = groundTrackRibbon(seconds, positions, this.#swath);
    if (!geometry) {
      return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (geometry as any)._workerPath = passThroughWorkerPath();
    return new GeometryInstance({ geometry, id: this.id });
  }
}

interface Cut {
  primitive: Primitive;
  material: Material;
  /** The time the vertex times count from. */
  at: JulianDate;
  reach: number;
}

export class GroundTrackBatch {
  readonly #viewer: Viewer;

  readonly #tracks = new Set<GroundTrack>();

  #shown: Cut | undefined;

  /** Being built, not in the scene yet. */
  #building: Cut | undefined;

  /** A rebuild is queued and waiting out the coalescing window. */
  #scheduled = false;

  #settledWaiters: Array<() => void> = [];

  constructor(viewer: Viewer) {
    this.#viewer = viewer;
    // Permanent, like the batch.
    viewer.clock.onTick.addEventListener(() => this.#recutIfDue());
    viewer.scene.preRender.addEventListener((_scene, time: JulianDate) => this.#clip(this.#shown, time));
  }

  get pending(): boolean {
    return this.#scheduled || this.#building !== undefined;
  }

  get size(): number {
    return this.#tracks.size;
  }

  add(track: GroundTrack): void {
    this.#tracks.add(track);
    this.#schedule();
  }

  remove(track: GroundTrack): void {
    this.#tracks.delete(track);
    this.#schedule();
  }

  /** The track's samples moved. One cut whole needs no rebuild; the clock decides when it is due. */
  refilled(track: GroundTrack): void {
    if (!track.complete) {
      this.#schedule();
    }
  }

  /** Resolves once the batch matches its tracks. The scene morph waits on it, as on the PolylineBatch. */
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

  #clip(cut: Cut | undefined, time: JulianDate): void {
    if (cut) {
      cut.material.uniforms.clockSeconds = JulianDate.secondsDifference(time, cut.at);
    }
  }

  #recutIfDue(): void {
    const shown = this.#shown;
    if (!shown || this.pending) {
      return;
    }
    if (Math.abs(JulianDate.secondsDifference(this.#viewer.clock.currentTime, shown.at)) >= shown.reach * RECUT_SHARE) {
      this.#build();
    }
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
      this.#build();
    });
  }

  #clear(): void {
    if (!this.#shown) {
      return;
    }
    this.#viewer.scene.primitives.remove(this.#shown.primitive);
    this.#shown = undefined;
    this.#viewer.scene.requestRender();
  }

  #build(): void {
    const at = JulianDate.clone(this.#viewer.clock.currentTime);
    const reach = reachSeconds(this.#viewer.clock.multiplier);
    const instances = [...this.#tracks].flatMap((track) => track.cut(at, reach) ?? []);
    if (instances.length === 0) {
      this.#clear();
      this.#finished();
      return;
    }
    const material = new Material({
      fabric: { uniforms: { trackColor: COLOR, clockSeconds: 0 }, source: MATERIAL_SOURCE },
      translucent: true,
    });
    const primitive = new Primitive({
      geometryInstances: instances,
      appearance: new Appearance({
        material,
        translucent: true,
        closed: false,
        vertexShaderSource: VERTEX_SHADER,
        fragmentShaderSource: FRAGMENT_SHADER,
        // What Cesium's private `Appearance.getDefaultRenderState` gives a translucent surface.
        renderState: { depthTest: { enabled: true }, depthMask: false, blending: BlendingState.ALPHA_BLEND },
      }),
    });
    const cut: Cut = { primitive, material, at, reach };
    this.#building = cut;
    driveBuild(this.#viewer, primitive, {
      ready: () => {
        this.#clip(cut, this.#viewer.clock.currentTime);
        this.#clear();
        this.#viewer.scene.primitives.add(primitive);
        this.#shown = cut;
        this.#viewer.scene.requestRender();
        this.#finished();
      },
      failed: () => this.#finished(),
    });
  }

  #finished(): void {
    this.#building = undefined;
    if (!this.pending) {
      this.#resolveSettled();
    }
  }
}
