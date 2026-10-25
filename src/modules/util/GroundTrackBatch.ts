// Every satellite's ground track in one Primitive, whose shader draws only the stretch
// from the clock to LEAD_SECONDS ahead. The clip follows the clock every frame; the
// ribbons are cut anew only as the clock nears their ends, so a rebuild in flight never
// shows. Re-cutting ground-clamped corridors instead left the track 50-150 km behind
// the satellite at x100: Cesium rebuilt them in workers, frames behind the clock.

import { Color, GeometryInstance, JulianDate, TimeInterval } from "@cesium/core";
import { Appearance, BlendingState, Material, Primitive, type Scene, SceneMode } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type { SampledTrajectory } from "../SampledTrajectory";
import { CesiumCallbackHelper } from "./CesiumCallbackHelper";
import { driveBuild } from "./driveBuild";
import { groundTrackRibbon, RIBBON_HEIGHT_METERS, type RibbonSwath, TRACK_SECONDS_ATTRIBUTE } from "./groundTrackRibbon";

/** How far ahead of the satellite its ground track reaches. Simulation seconds. */
export const LEAD_SECONDS = 300;

/** Ticks to coalesce over, so a hundred satellites arriving cost one rebuild. */
const COALESCE_TICKS = 30;

// Simulation seconds a cut reaches past the drawn stretch, either way. Within the
// trajectory's window: a refill every quarter orbit keeps 1,320 s behind at 88 minutes.
// The reach stops growing from x600. A clock or a scrub that crosses the rest of it while
// a build is in flight outruns the cut, and the drawn stretch shortens until the next lands.

/** At rest, and up to x300. */
const MIN_REACH_SECONDS = 600;

/** The most the trajectory's window holds either side. */
const MAX_REACH_SECONDS = 1200;

/** Wall seconds of clock a cut should outlast, so a fast clock cuts farther. */
const REACH_WALL_SECONDS = 2;

/** Per tick, how much of the peak clock rate is kept: half of it is gone after 14 ticks. */
const RATE_DECAY = 0.95;

/**
 * Metres above the ellipsoid. Below this the camera looks up at the ribbon, which reads
 * as a ceiling: the sky view's eye is 2 m up, and a surface model is seen from street
 * level.
 */
const HIDDEN_BELOW_METERS = 2 * RIBBON_HEIGHT_METERS;

/** The share of the reach the clock may cover before the next cut; the rest is for the build. */
const RECUT_SHARE = 1 / 3;

/** The corridor's colour before it. */
const COLOR = Color.DARKRED.withAlpha(0.25);

/** Shaped like Cesium's PerInstanceFlatColorAppearanceVS, which `Primitive` rewrites for 2D and morphs. */
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

/** Discards what is behind the clock or past the lead. */
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

/** Simulation seconds a cut reaches past the drawn stretch, for a clock moving `rate` simulation seconds a wall second. */
export function reachSeconds(rate: number): number {
  return Math.min(MAX_REACH_SECONDS, Math.max(MIN_REACH_SECONDS, rate * REACH_WALL_SECONDS));
}

/** One satellite's ground track: the component the "Ground track" kind hands its collection. */
export class GroundTrack {
  /** The samples the ribbon is cut from. */
  readonly #trajectory: Pick<SampledTrajectory, "interval" | "samplesBetween">;

  readonly #swath: RibbonSwath;

  /** What a click on the ribbon picks, read at every cut: the satellite's entity selects it. */
  readonly #pickId: () => unknown;

  #coversReach = false;

  constructor(trajectory: Pick<SampledTrajectory, "interval" | "samplesBetween">, swath: RibbonSwath, pickId: () => unknown) {
    this.#trajectory = trajectory;
    this.#swath = swath;
    this.#pickId = pickId;
  }

  /** Whether the last cut found samples over all of its reach; a refill re-cuts only one that did not. */
  get coversReach(): boolean {
    return this.#coversReach;
  }

  /** Simulation seconds `reach` either side of the drawn stretch; the vertex times count from `epoch`. */
  cut(epoch: JulianDate, reach: number): GeometryInstance | undefined {
    const start = JulianDate.addSeconds(epoch, -reach, new JulianDate());
    const stop = JulianDate.addSeconds(epoch, LEAD_SECONDS + reach, new JulianDate());
    const interval = this.#trajectory.interval;
    this.#coversReach = interval !== undefined && TimeInterval.contains(interval, start) && TimeInterval.contains(interval, stop);
    const { times, positions } = this.#trajectory.samplesBetween(start, stop);
    const seconds = times.map((sampleTime) => JulianDate.secondsDifference(sampleTime, epoch));
    const geometry = groundTrackRibbon(seconds, positions, this.#swath);
    if (!geometry) {
      return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (geometry as any)._workerPath = passThroughWorkerPath();
    return new GeometryInstance({ geometry, id: this.#pickId() });
  }
}

/** One build of the batch. */
interface Cut {
  primitive: Primitive;
  /** Holds the clock uniform. */
  material: Material;
  /** The time the vertex times count from. */
  epoch: JulianDate;
  /** Simulation seconds. */
  reach: number;
}

/** The shared primitive every ground track is drawn into, in every scene mode. */
export class GroundTrackBatch {
  readonly #viewer: Viewer;

  readonly #tracks = new Set<GroundTrack>();

  /** In the scene. */
  #shown: Cut | undefined;

  /** Being built, not in the scene yet. */
  #building: Cut | undefined;

  /** A rebuild is queued and waiting out the coalescing window. */
  #scheduled = false;

  /** Simulation seconds a wall second, decaying from its peak, so a scrub cuts as far as a fast clock. */
  #rate = 0;

  /** The tick before, for `#rate`. */
  #lastTick: { time: JulianDate; wallMs: number } | undefined;

  constructor(viewer: Viewer) {
    this.#viewer = viewer;
    // Permanent, like the batch.
    viewer.clock.onTick.addEventListener(() => this.#tick());
    viewer.scene.preRender.addEventListener((scene: Scene, time: JulianDate) => this.#clip(this.#shown, scene, time));
  }

  /** Drawn from the next build. */
  add(track: GroundTrack): void {
    this.#tracks.add(track);
    this.#schedule();
  }

  /** Gone with the next build. */
  remove(track: GroundTrack): void {
    this.#tracks.delete(track);
    this.#schedule();
  }

  /** The track's samples moved. One cut whole needs no rebuild; the clock decides when it is due. */
  refilled(track: GroundTrack): void {
    if (!track.coversReach) {
      this.#schedule();
    }
  }

  get #pending(): boolean {
    return this.#scheduled || this.#building !== undefined;
  }

  /** Sets the clock uniform to the time the frame is drawn at, which every entity is drawn at too. */
  #clip(cut: Cut | undefined, scene: Scene, time: JulianDate): void {
    if (!cut) {
      return;
    }
    cut.material.uniforms.clockSeconds = JulianDate.secondsDifference(time, cut.epoch);
    cut.primitive.show = scene.mode !== SceneMode.SCENE3D || scene.camera.positionCartographic.height >= HIDDEN_BELOW_METERS;
  }

  /** Measures the clock's rate and starts a build once the clock has used its share of the reach. */
  #tick(): void {
    const time = this.#viewer.clock.currentTime;
    const wallMs = performance.now();
    const last = this.#lastTick;
    if (last && wallMs > last.wallMs) {
      const rate = Math.abs(JulianDate.secondsDifference(time, last.time)) / ((wallMs - last.wallMs) / 1000);
      this.#rate = Math.max(rate, this.#rate * RATE_DECAY);
    }
    this.#lastTick = { time: JulianDate.clone(time, last?.time), wallMs };

    const shown = this.#shown;
    if (shown && !this.#pending && Math.abs(JulianDate.secondsDifference(time, shown.epoch)) >= shown.reach * RECUT_SHARE) {
      this.#build();
    }
  }

  /** Builds once the coalescing window has passed and no build is in flight. */
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

  /** Takes the shown cut out of the scene; `PrimitiveCollection.remove` destroys it. */
  #clear(): void {
    if (!this.#shown) {
      return;
    }
    this.#viewer.scene.primitives.remove(this.#shown.primitive);
    this.#shown = undefined;
    this.#viewer.scene.requestRender();
  }

  /** Cuts every track at the clock and swaps the build in once it is ready; the shown cut draws until then. */
  #build(): void {
    const epoch = JulianDate.clone(this.#viewer.clock.currentTime);
    const reach = reachSeconds(this.#rate);
    const instances = [...this.#tracks].flatMap((track) => track.cut(epoch, reach) ?? []);
    if (instances.length === 0) {
      this.#clear();
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
    const cut: Cut = { primitive, material, epoch, reach };
    this.#building = cut;
    driveBuild(this.#viewer, primitive, {
      ready: () => {
        this.#clip(cut, this.#viewer.scene, this.#viewer.clock.currentTime);
        this.#clear();
        this.#viewer.scene.primitives.add(primitive);
        this.#shown = cut;
        this.#building = undefined;
        this.#viewer.scene.requestRender();
      },
      failed: () => {
        this.#building = undefined;
      },
    });
  }
}
