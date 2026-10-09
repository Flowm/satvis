import { CallbackProperty, Camera, Cartesian3, Entity, EntityView, GeometryInstance, JulianDate, type Scene, SceneMode, VelocityOrientationProperty } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import { clearPassHighlights, setPassHighlights } from "../composables/usePassHighlights";
import { type Component, type ComponentHost, componentKind, ModelSize, type SatelliteBatches, type SkyAppearance } from "./componentKinds";
import type { GroundStation } from "./PassPredictor";
import type { CatalogEntry } from "./SatelliteCatalog";
import { SatelliteProperties } from "./SatelliteProperties";
import { cancelPendingTrack, trackEntity, trackWhenReady, type CameraPose } from "./trackFlight";
import type { PassPredictorSource } from "./util/passSource";
import type { SampleChunk, TrajectorySampler } from "./util/sampleSource";

export type { SatelliteBatches } from "./componentKinds";

type SatelliteComponentName = string;

/** Where tracking starts, east-north-up from the satellite. */
const VIEW_FROM = new Cartesian3(0, -3600000, 4200000);
/**
 * South-east of and above the model, in model radii: a cubesat and the ISS differ 300-fold.
 * 34° up, past the 20–23° a low orbit's horizon dips, so the model is seen against the ground.
 */
const VIEW_FROM_MODEL_DIRECTION = Cartesian3.normalize(new Cartesian3(9, -10, 9), new Cartesian3());
const VIEW_FROM_MODEL_RADII = 6;

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

  /** Kept across components, so one created in the sky view is born dimmed or hidden. */
  #skyAppearance: SkyAppearance = "normal";

  /** What a click or a track acts on: the first Entity created. */
  defaultEntity: Entity | undefined;

  eventListeners: Record<string, () => void> = {};

  /**
   * `opening` is the satellite's first window of samples. The trajectory follows the
   * clock from here until `dispose`, whichever components come and go.
   */
  constructor(viewer: Viewer, entry: CatalogEntry, batches: SatelliteBatches, sampler: TrajectorySampler, passes: PassPredictorSource, opening: SampleChunk) {
    this.viewer = viewer;
    this.props = new SatelliteProperties(entry, sampler, passes);
    this.batches = batches;
    this.model = new ModelSize(viewer, () => this.#components["3D model"]);
    this.props.trajectory.adopt(opening);
    this.props.trajectory.follow(viewer, () => this.#bindAll());
  }

  /**
   * Prediction is off-thread, so this may paint a stale or empty band; the
   * `passesChanged` listener paints the real one.
   */
  #highlightPasses(): void {
    const predictor = this.props.passPredictor;
    const time = this.viewer.clock.currentTime;
    if (this.isSelected) {
      setPassHighlights(predictor.passes(time));
    } else {
      // The tracked satellite still needs the window for its ground-station link.
      predictor.passes(time);
    }
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
      componentKind(name)?.appear?.(component, this);
    }
    this.#requestFrameIfPaused();
  }

  get components(): Readonly<Record<string, Component>> {
    return this.#components;
  }

  get componentNames(): string[] {
    return Object.keys(this.#components);
  }

  get created(): boolean {
    return this.componentNames.length > 0;
  }

  get isSelected(): boolean {
    return Object.values(this.#components).some((component) => this.viewer.selectedEntity === component);
  }

  get isTracked(): boolean {
    return Object.values(this.#components).some((component) => this.viewer.trackedEntity === component);
  }

  show(componentNames: string[] = this.componentNames): void {
    componentNames.forEach((name) => this.enableComponent(name));
  }

  hide(componentNames: string[] = this.componentNames): void {
    componentNames.forEach((name) => this.disableComponent(name));
  }

  /** `animate` flies to the tracked view first, in 3D. */
  track(animate = false): void {
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
        trackEntity(this.viewer, () => this.defaultEntity, pose);
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
  entity(entityKey: string, entityValue: any, position: any, moving: boolean): Entity {
    const entity = new Entity({
      name: this.props.name,
      position,
      viewFrom: this.#viewFrom(),
    });
    if (moving) {
      entity.orientation = new VelocityOrientationProperty(position);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entity as any)[entityKey] = entityValue;
    return entity;
  }

  enableComponent(name: SatelliteComponentName): void {
    const kind = componentKind(name);
    if (!kind) {
      console.error(`Unknown component ${name}`);
      return;
    }
    if (!this.created) {
      this.init();
    }
    if (!this.props.trajectory.valid) {
      console.error(`No valid position data available for ${this.props.name}`);
      return;
    }
    let component = this.#components[name];
    if (!component) {
      component = kind.create(this);
      if (!component) {
        // The satellite cannot draw it, and an empty collection keeps no listeners.
        if (!this.created) {
          this.deinit();
        }
        return;
      }
      this.#components[name] = component;
      if (this.#skyAppearance !== "normal") {
        kind.appear?.(component, this);
      }
      this.#bind(name, component, false);
      this.#requestFrameIfPaused();
    }

    if (component instanceof Entity) {
      if (!this.viewer.entities.contains(component)) {
        this.viewer.entities.add(component);
      }
      this.defaultEntity ??= component;
    } else {
      kind.batch?.(this).add(component);
    }

    if (name === "3D model") {
      this.#setViewFrom();
    }
  }

  disableComponent(name: SatelliteComponentName): void {
    const component = this.#components[name];
    if (component instanceof Entity) {
      this.viewer.entities.remove(component);
    } else if (component instanceof GeometryInstance) {
      componentKind(name)?.batch?.(this).remove(component);
    }
    delete this.#components[name];
    if (name === "3D model") {
      this.#setViewFrom();
    }

    if (this.defaultEntity === component) {
      this.defaultEntity = Object.values(this.#components).find((remaining) => remaining instanceof Entity);
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

  #viewFrom(): Cartesian3 | CallbackProperty {
    return "3D model" in this.#components ? this.#modelViewFrom : VIEW_FROM;
  }

  /**
   * A callback: the model's size is known only once loaded, and EntityView reads it when tracking starts.
   */
  readonly #modelViewFrom = new CallbackProperty(
    (_time, result?: Cartesian3) => Cartesian3.multiplyByScalar(VIEW_FROM_MODEL_DIRECTION, VIEW_FROM_MODEL_RADII * this.model.radius(), result ?? new Cartesian3()),
    false,
  );

  /** Read when tracking starts, so a camera already following the satellite stays put. */
  #setViewFrom(): void {
    for (const component of Object.values(this.#components)) {
      if (component instanceof Entity) {
        component.viewFrom = this.#viewFrom() as unknown as typeof component.viewFrom;
      }
    }
  }

  init(): void {
    // Prediction answers late. The ground-station link reads passIntervals every
    // frame; the timeline bands are painted once and must be told.
    this.eventListeners.passesChanged = this.props.passPredictor.onChanged(() => {
      if (this.isSelected) {
        setPassHighlights(this.props.passPredictor.passes(this.viewer.clock.currentTime));
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.eventListeners.selectedEntity = this.viewer.selectedEntityChanged.addEventListener((entity: any) => {
      if (!entity || entity?.name === "Ground station") {
        clearPassHighlights();
        return;
      }
      if (this.isSelected) {
        this.#highlightPasses();
      }
    });

    this.eventListeners.trackedEntity = this.viewer.trackedEntityChanged.addEventListener(() => {
      if (this.isTracked) {
        this.artificiallyTrack();
      }
      this.#refit();
    });
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
    this.hide();
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

  /** Whether the ground track has caught up with its last positions; undefined without one or without Cesium's answer. */
  groundTrackSettled(): boolean | undefined {
    const component = this.#components["Ground track"];
    return component && componentKind("Ground track")?.settled?.(component, this);
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

    // The setter clears the predictor's window; the answer arrives via `passesChanged`.
    this.props.passPredictor.groundStations = groundStations;
    if (this.isSelected || this.isTracked) {
      this.#highlightPasses();
    }
  }
}
