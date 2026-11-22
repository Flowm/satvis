import { Cartesian3, Cartographic, JulianDate, Math as CesiumMath } from "@cesium/core";
import { CallbackProperty, Camera, Entity, EntityView, type Scene, SceneMode } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type { GroundPoint } from "@/modules/util/cmrGranules";
import type { PassPredictorSource } from "@/modules/util/passSource";
import type { SampleChunk, TrajectorySampler } from "@/modules/util/sampleSource";

import { type Component, type ComponentHost, componentKind, deferPointToModel, modelCopies, ModelSize, type SatelliteBatches, type SkyAppearance } from "./componentKinds";
import type { GroundStation } from "./PassPredictor";
import { type BroadcastTarget, chaseOffset, chaseTilt } from "./ReplayCamera";
import type { CatalogEntry } from "./SatelliteCatalog";
import { SatelliteProperties } from "./SatelliteProperties";
import { cancelPendingTrack, trackEntity, trackWhenReady, type CameraPose } from "./trackFlight";

type SatelliteComponentName = string;

/**
 * Where tracking starts from the satellite, in the axes EntityView picks: east, north and up only
 * for what holds still. A low orbit's are its motion through inertial space, the orbit's normal
 * and up; a higher one's down, west and north.
 */
const VIEW_FROM = new Cartesian3(0, -3600000, 4200000);
/**
 * Ahead of the model to its right and above, in model radii: a cubesat and the ISS differ 300-fold.
 * 34° up, past the 20–23° a low orbit's horizon dips, so the model is seen against the ground.
 */
const VIEW_FROM_MODEL_DIRECTION = Cartesian3.normalize(new Cartesian3(9, -10, 9), new Cartesian3());
const VIEW_FROM_MODEL_RADII = 6;

/** How many frames after tracking starts the chase is turned down whenever EntityView has aimed it at the satellite. */
const CHASE_TILT_FRAMES = 120;

/** Radians. A camera aimed at the satellite as EntityView aims it, not turned down past it. */
const AIMED_AT_RADIANS = CesiumMath.toRadians(0.2);

/**
 * `EntityView` has no destroy(), and its velocity property stays subscribed to the
 * entity's position until that is cleared. The field is private, hence optional.
 */
function releaseEntityView(view: EntityView): void {
  const velocity = (view as unknown as { _velocityProperty?: { position: unknown } })._velocityProperty;
  if (velocity) {
    velocity.position = undefined;
  }
}

/** One satellite's Cesium objects, created on demand and dropped on disable. What each kind is lives in componentKinds.ts. */
export class SatelliteComponentCollection implements ComponentHost {
  readonly viewer: Viewer;

  readonly props: SatelliteProperties;

  readonly batches: SatelliteBatches;

  readonly model: ModelSize;

  #components: Record<string, Component> = {};

  /** The "3D model"'s lower-detail copies (ADR 0007), added, bound and styled with it. */
  #modelCopies: Entity[] = [];

  /** Kept across components, so one created in the sky view is born dimmed or hidden. */
  #skyAppearance: SkyAppearance = "normal";

  eventListeners: Record<string, () => void> = {};

  /** Whether a granule layer of this satellite is on: tracking it then chases its swath (ADR 0023). Set by the manager. */
  recordedSwathShown: () => boolean = () => false;

  /** Tracked from the chase: its swath was on when tracking started, which is when EntityView reads viewFrom. */
  #chasing = false;

  /**
   * `opening` is the satellite's first window of samples. The trajectory follows the
   * clock from here until `dispose`, whichever components come and go.
   */
  constructor(viewer: Viewer, entry: CatalogEntry, batches: SatelliteBatches, sampler: TrajectorySampler, passes: PassPredictorSource, opening: SampleChunk) {
    this.viewer = viewer;
    this.props = new SatelliteProperties(entry, sampler, passes);
    this.batches = batches;
    this.model = new ModelSize(
      viewer,
      () => {
        const model = this.#components["3D model"];
        return model instanceof Entity ? [model, ...this.#modelCopies] : [];
      },
      () => this.props.model?.lods ?? [],
      () => this.isTracked,
    );
    this.props.trajectory.adopt(opening);
    this.props.trajectory.follow(viewer, () => this.#bindAll());
  }

  /** Written by the sky view each frame, so an unchanged value returns at once. */
  get skyAppearance(): SkyAppearance {
    return this.#skyAppearance;
  }

  set skyAppearance(appearance: SkyAppearance) {
    if (appearance === this.#skyAppearance) {
      return;
    }
    this.#skyAppearance = appearance;
    for (const [name, component] of Object.entries(this.#components)) {
      for (const drawn of [component, ...this.#modelCopiesOf(name)]) {
        componentKind(name)?.appear?.(drawn, this);
      }
    }
    this.#requestFrameIfPaused();
  }

  get components(): Readonly<Record<string, Component>> {
    return this.#components;
  }

  get componentNames(): string[] {
    return Object.keys(this.#components);
  }

  /** What a click or a track acts on: the first Entity among the components, in the order they were created. */
  get defaultEntity(): Entity | undefined {
    return Object.values(this.#components).find((component) => component instanceof Entity);
  }

  get created(): boolean {
    return this.componentNames.length > 0;
  }

  get isSelected(): boolean {
    return this.#pickable().some((component) => this.viewer.selectedEntity === component);
  }

  get isTracked(): boolean {
    return this.#pickable().some((component) => this.viewer.trackedEntity === component);
  }

  /** Everything a pick can land on: the components and the model's copies. */
  #pickable(): Component[] {
    return [...Object.values(this.#components), ...this.#modelCopies];
  }

  show(componentNames: string[]): void {
    componentNames.forEach((name) => this.enableComponent(name));
  }

  /** `animate` flies to the tracked view first, in 3D, taking `duration` seconds where given. */
  track(animate = false, duration?: number): void {
    // The distance is the model's size: tracked while loading, the ISS is framed from inside.
    trackWhenReady(
      this.viewer,
      this,
      () => !this.model.pending,
      () => {
        if (!this.defaultEntity) {
          return;
        }
        const pose = animate && this.viewer.scene.mode === SceneMode.SCENE3D ? this.#trackedCameraPose(this.defaultEntity) : undefined;
        trackEntity(this.viewer, () => this.defaultEntity, pose, duration);
      },
    );
  }

  /**
   * Where engaging `trackedEntity` would put the camera now, so a flight lands
   * without a jump. `EntityView` moves the camera it is given, so it gets its own.
   */
  #trackedCameraPose(entity: Entity): CameraPose {
    const { scene } = this.viewer;
    const camera = new Camera(scene);
    const probe = new EntityView(entity, Object.create(scene, { camera: { value: camera } }) as Scene, scene.globe.ellipsoid);
    probe.update(this.viewer.clock.currentTime);
    releaseEntityView(probe);
    const tilt = this.#chaseTilt(this.viewer.clock.currentTime);
    if (tilt !== undefined) camera.lookDown(tilt);
    return { destination: Cartesian3.clone(camera.positionWC), direction: Cartesian3.clone(camera.directionWC), up: Cartesian3.clone(camera.upWC) };
  }

  artificiallyTrack(): void {
    const entity = this.defaultEntity;
    if (!entity) {
      return;
    }
    const cameraTracker = new EntityView(entity, this.viewer.scene, this.viewer.scene.globe.ellipsoid);
    const removeTick = this.viewer.clock.onTick.addEventListener((clock) => {
      cameraTracker.update(clock.currentTime);
    });
    const removeTracked = this.viewer.trackedEntityChanged.addEventListener(() => {
      removeTick();
      removeTracked();
      releaseEntityView(cameraTracker);
    });
  }

  /** For the kinds: an entity named after the satellite, framed for tracking. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entity(entityKey: string, entityValue: any, position: any): Entity {
    const entity = new Entity({
      name: this.props.name,
      position,
      viewFrom: this.#viewFrom,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entity as any)[entityKey] = entityValue;
    return entity;
  }

  /** A component already drawn is left as it is: a batch gives a line one slot per add. */
  enableComponent(name: SatelliteComponentName): void {
    if (this.#components[name]) {
      return;
    }
    const kind = componentKind(name);
    if (!kind) {
      console.error(`Unknown component ${name}`);
      return;
    }
    if (!this.props.trajectory.valid) {
      console.error(`No valid position data available for ${this.props.name}`);
      return;
    }
    const component = kind.create(this);
    if (!component) {
      return;
    }
    // An empty collection keeps no listeners.
    if (!this.created) {
      this.init();
    }
    this.#components[name] = component;
    if (name === "3D model") {
      this.#modelCopies = modelCopies(this);
    }
    if (name === "3D model" || name === "Point") {
      deferPointToModel(this.#components.Point, this, "3D model" in this.#components);
    }
    if (this.#skyAppearance !== "normal") {
      kind.appear?.(component, this);
      this.#modelCopiesOf(name).forEach((copy) => kind.appear?.(copy, this));
    }
    this.#bind(name, component, false);
    this.#requestFrameIfPaused();

    if (component instanceof Entity) {
      [component, ...this.#modelCopiesOf(name)].forEach((entity) => this.viewer.entities.add(entity));
    } else {
      kind.batch?.(this).add(component);
    }
  }

  disableComponent(name: SatelliteComponentName): void {
    const component = this.#components[name];
    if (component instanceof Entity) {
      this.viewer.entities.remove(component);
    } else if (component) {
      componentKind(name)?.batch?.(this).remove(component);
    }
    delete this.#components[name];
    if (name === "3D model") {
      this.#modelCopies.forEach((copy) => this.viewer.entities.remove(copy));
      this.#modelCopies = [];
      this.model.reset();
      deferPointToModel(this.#components.Point, this, false);
    }

    if (this.componentNames.length === 0) {
      this.deinit();
    }
  }

  /** A geometry cannot change in place, so recreating is removing and adding. */
  #recreate(name: SatelliteComponentName): void {
    this.disableComponent(name);
    this.enableComponent(name);
  }

  /** The copies that come and go with component `name`: the model's, for "3D model". */
  #modelCopiesOf(name: SatelliteComponentName): Entity[] {
    return name === "3D model" ? this.#modelCopies : [];
  }

  /**
   * Where tracking starts from: the chase while the recorded swath is on, else beside the
   * model, else VIEW_FROM. A callback, as EntityView reads it when tracking starts, once the
   * model's size is known, so a camera already following the satellite stays put.
   */
  readonly #viewFrom = new CallbackProperty((time, result?: Cartesian3) => {
    const offset = result ?? new Cartesian3();
    if (this.recordedSwathShown()) {
      return chaseOffset(this.props.swathWidthKm, this.#altitudeM(time), offset);
    }
    if ("3D model" in this.#components) {
      return Cartesian3.multiplyByScalar(VIEW_FROM_MODEL_DIRECTION, VIEW_FROM_MODEL_RADII * this.model.radius(), offset);
    }
    return Cartesian3.clone(VIEW_FROM, offset);
  }, false);

  /** Metres; a low orbit's where the trajectory has no position. */
  #altitudeM(time: JulianDate | undefined): number {
    const position = time && this.props.trajectory.position(time);
    return (position && Cartographic.fromCartesian(position)?.height) ?? 800_000;
  }

  /** How far the chase looks down past the satellite (chaseTilt), or undefined when tracking does not chase. */
  #chaseTilt(time: JulianDate): number | undefined {
    return this.recordedSwathShown() ? chaseTilt(this.props.swathWidthKm, this.#altitudeM(time)) : undefined;
  }

  /** Whether the camera tracks it from the chase, which a track started with its swath off does not, until tracked again. */
  get chasing(): boolean {
    return this.isTracked && this.#chasing;
  }

  /** What a replay's broadcast camera follows over `station`: this satellite and its swath. */
  broadcastTarget(station: GroundPoint): BroadcastTarget {
    return { position: (time) => this.props.trajectory.position(time), station, swathKm: this.props.swathWidthKm };
  }

  /**
   * Turns the chase down past the satellite once tracking has started. EntityView aims at the
   * satellite on its first update and keeps the camera's direction after. The Viewer's first
   * update waits for the satellite's bounding sphere, artificiallyTrack's does not, so for a
   * while after the start, the camera is turned down whenever it is found aimed at the
   * satellite: before each frame is drawn, after the updates, so no frame shows it aimed.
   */
  #tiltChase(): void {
    const { clock, scene } = this.viewer;
    let frames = CHASE_TILT_FRAMES;
    const remove = scene.preRender.addEventListener(() => {
      const tilt = this.#chaseTilt(clock.currentTime);
      const satellite = this.defaultEntity?.position?.getValue(clock.currentTime);
      if (--frames <= 0 || tilt === undefined || !this.isTracked || satellite === undefined) {
        remove();
        return;
      }
      const { camera } = scene;
      const toSatellite = Cartesian3.normalize(Cartesian3.subtract(satellite, camera.positionWC, new Cartesian3()), new Cartesian3());
      if (scene.mode === SceneMode.SCENE3D && Cartesian3.angleBetween(toSatellite, camera.directionWC) < AIMED_AT_RADIANS) {
        camera.lookDown(tilt);
      }
    });
  }

  init(): void {
    this.eventListeners.trackedEntity = this.viewer.trackedEntityChanged.addEventListener(() => {
      // A copy hides once the tracked model grows, and Cesium follows only what it can measure.
      if (this.#isModelCopy(this.viewer.trackedEntity)) {
        this.viewer.trackedEntity = this.#components["3D model"] as Entity;
        return;
      }
      this.#chasing = this.isTracked && this.recordedSwathShown();
      if (this.isTracked) {
        this.artificiallyTrack();
        this.#tiltChase();
      }
      this.#refit();
    });
    this.eventListeners.selectedEntity = this.viewer.selectedEntityChanged.addEventListener(() => {
      if (this.#isModelCopy(this.viewer.selectedEntity)) {
        this.viewer.selectedEntity = this.#components["3D model"] as Entity;
      }
    });
  }

  /** Whether `entity` is one of the model's copies, which a pick may land on in its place. */
  #isModelCopy(entity: Entity | undefined): boolean {
    return entity !== undefined && this.#modelCopies.includes(entity);
  }

  /** Recreates every component whose representation no longer suits the scene mode or the tracking. */
  #refit(): void {
    for (const [name, component] of Object.entries(this.#components)) {
      const fits = componentKind(name)?.fits;
      if (fits && !fits(component, this)) {
        this.#recreate(name);
      }
    }
  }

  deinit(): void {
    // Iterate rather than name them, so a listener added to `init` cannot leak.
    Object.values(this.eventListeners).forEach((remove) => remove?.());
    this.eventListeners = {};
    cancelPendingTrack(this.viewer, this);
  }

  /** Idempotent and final: disabling the last component calls `deinit()`, and the trajectory stops. */
  dispose(): void {
    this.componentNames.forEach((name) => this.disableComponent(name));
    this.props.trajectory.stop();
  }

  /** Every component, after the trajectory refilled. */
  #bindAll(): void {
    // Not the inertial frame or the sampled property: both exist only when a component asks.
    if (!this.props.trajectory.entityPosition) return;
    for (const [name, component] of Object.entries(this.#components)) {
      this.#bind(name, component, true);
    }
    this.#requestFrameIfPaused();
  }

  /** A paused clock under render-on-demand would not show the change. */
  #requestFrameIfPaused(): void {
    if (!this.viewer.clock.shouldAnimate) {
      const removeCallback = this.viewer.clock.onTick.addEventListener(() => {
        this.viewer.scene.requestRender();
        removeCallback();
      });
    }
  }

  #bind(name: SatelliteComponentName, component: Component, refilled: boolean): void {
    this.#modelCopiesOf(name).forEach((copy) => componentKind(name)?.bind(copy, this, refilled));
    const outcome = componentKind(name)?.bind(component, this, refilled);
    if (outcome === "recreate") {
      this.#recreate(name);
    } else if (outcome === "recut") {
      this.recut(name, this.viewer.clock.currentTime);
    }
  }

  /** Cuts a component anew for `time`, if its kind follows time that way. */
  recut(name: SatelliteComponentName, time: JulianDate): void {
    const component = this.#components[name];
    const recut = componentKind(name)?.recut;
    if (component && recut) {
      this.#components[name] = recut(component, this, time);
    }
  }

  /** The station of the pass containing `time`, else the first station. */
  groundStationAt(time: JulianDate): Cartesian3 | undefined {
    const groundStations = this.props.passPredictor.groundStations;
    if (groundStations.length === 0) {
      return undefined;
    }
    const timeMs = JulianDate.toDate(time).getTime();
    const activePass = this.props.passPredictor.passes(time).find((pass) => timeMs >= pass.start && timeMs <= pass.end);
    const target = (activePass && groundStations.find((gs) => gs.name === activePass.groundStationName)) ?? groundStations[0];
    if (!target) {
      return undefined;
    }
    return Cartesian3.fromDegrees(target.position.longitude, target.position.latitude, target.position.height);
  }

  set groundStations(groundStations: GroundStation[]) {
    // GEO and above never pass over a station.
    if (this.props.orbit.orbitalPeriod > 60 * 12) {
      return;
    }

    // Clears the predictor's window; whatever reads the passes next asks again.
    this.props.passPredictor.groundStations = groundStations;
  }
}
