import {
  ArcType,
  BoundingSphere,
  CallbackProperty,
  Camera,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CornerType,
  CorridorGraphics,
  DistanceDisplayCondition,
  Entity,
  EntityView,
  GeometryInstance,
  HeightReference,
  HorizontalOrigin,
  JulianDate,
  LabelGraphics,
  LabelStyle,
  ModelGraphics,
  NearFarScalar,
  PathGraphics,
  PerspectiveFrustum,
  PointGraphics,
  PolylineColorAppearance,
  PolylineGeometry,
  PolylineGlowMaterialProperty,
  PolylineGraphics,
  type Scene,
  SceneMode,
  VelocityOrientationProperty,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import CesiumSensorVolumes from "cesium-sensor-volumes";

import { clearPassHighlights, setPassHighlights } from "../composables/usePassHighlights";
import { SATELLITE_COMPONENTS } from "../config/components";
import { defaultViewDistance } from "../config/defaultView";
import { ORBIT_CLASS_COLOR, type OrbitClass } from "../config/orbitClass";
import type { GroundStation } from "./PassPredictor";
import type { CatalogEntry } from "./SatelliteCatalog";
import { coneDescription, coneOrientation, groundTrackDescription, modelUrl, orbitPathTimes, orbitTrackTimes, orbitUsesPathGraphic } from "./satelliteGraphics";
import { SatelliteProperties } from "./SatelliteProperties";
import { cancelPendingTrack, trackEntity, trackWhenReady, type CameraPose } from "./trackFlight";
import { drawablePositions } from "./util/drawablePositions";
import type { PassPredictorSource } from "./util/passSource";
import type { PolylineBatch } from "./util/PolylineBatch";
import type { TrajectorySampler } from "./util/sampleSource";

type SatelliteComponentName = string;

/** The shared polyline batches a satellite draws its orbit lines into. */
export interface SatelliteBatches {
  /** Inertial: the Orbit component's closed ellipse. */
  orbits: PolylineBatch;
  /** Fixed: the Orbit track component's Earth-relative path. */
  tracks: PolylineBatch;
}

/** Converted once and shared by every point, like Cesium's own Color constants. */
const POINT_COLOR = Object.fromEntries(Object.entries(ORBIT_CLASS_COLOR).map(([orbitClass, hex]) => [orbitClass, Color.fromCssColorString(hex)])) as Record<OrbitClass, Color>;

/** `BoundingSphereState.PENDING`, which the engine's type declarations do not export. */
const BOUNDING_SPHERE_PENDING = 1;
const BOUNDING_SPHERE_DONE = 0;

/** Where tracking starts, east-north-up from the satellite. */
const VIEW_FROM = new Cartesian3(0, -3600000, 4200000);
/** South-east of and above the model, in model radii: a cubesat and the ISS differ 300-fold. */
const VIEW_FROM_MODEL_DIRECTION = Cartesian3.normalize(new Cartesian3(9, -10, 5), new Cartesian3());
const VIEW_FROM_MODEL_RADII = 6;
/** For a model not loaded yet: a small satellite's. */
const FALLBACK_MODEL_RADIUS = 2.5;

/**
 * The smallest a model is drawn, in css pixels, by its bounding-sphere diameter in
 * metres: a cubesat at 20, Landsat at 55, the ISS at 72. A cube root, not a log: a
 * log drew a compact cubesat as large as Landsat.
 */
export function modelMinimumPixelSize(diameter: number): number {
  return Math.min(72, Math.max(20, 23 * Math.cbrt(diameter)));
}

/**
 * CSS pixels, the orbit's and the orbit track's. At 2 px the orbits bunched around a
 * zoomed-out globe read as bold; 1 px draws two thirds of their light.
 */
const ORBIT_WIDTH = 1;

// CSS pixels.
const LABEL_OFFSET = 10;
const LABEL_MODEL_GAP = 4;
/** Below this across, a model is too small to stand in for its point. */
const MODEL_MARKER_PIXELS = 10;

/** Keyed by the config list, so a component without a creator is a compile error. */
const CREATORS: Record<(typeof SATELLITE_COMPONENTS)[number], (sat: SatelliteComponentCollection) => void> = {
  Point: (sat) => sat.createPoint(),
  Label: (sat) => sat.createLabel(),
  Orbit: (sat) => sat.createOrbit(),
  "Orbit track": (sat) => sat.createOrbitTrack(),
  "Ground track": (sat) => sat.createGroundTrack(),
  "Sensor cone": (sat) => sat.createCone(),
  "3D model": (sat) => sat.createModel(),
  "Ground station link": (sat) => sat.createGroundStationLink(),
};

/**
 * `PolylineGeometry` throws below this, and a throw during a rebuild escapes
 * through `clock.tick` and stops Cesium's render loop for the session.
 */
const MIN_POLYLINE_POSITIONS = 2;

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

/** A GeometryInstance when merged into a shared orbit batch. */
type Component = Entity | GeometryInstance;

/** One satellite's Cesium objects, created on demand and dropped on disable. */
export class SatelliteComponentCollection {
  static readonly #sphereScratch = new BoundingSphere();
  static readonly #pixelScratch = new Cartesian2();

  static #reportedMissingBoundingSphere = false;

  static #reportMissingBoundingSphere(): void {
    if (SatelliteComponentCollection.#reportedMissingBoundingSphere) {
      return;
    }
    SatelliteComponentCollection.#reportedMissingBoundingSphere = true;
    console.error("Cesium DataSourceDisplay has no getBoundingSphere; pacing ground tracks on a fixed schedule instead. Cesium internals have moved — see groundTrackSettled.");
  }

  readonly viewer: Viewer;

  readonly props: SatelliteProperties;

  readonly #orbits: PolylineBatch;

  readonly #tracks: PolylineBatch;

  #components: Record<string, Component> = {};

  /** What a click or a track acts on: the first Entity created. */
  defaultEntity: Entity | undefined;

  eventListeners: Record<string, () => void> = {};

  constructor(viewer: Viewer, entry: CatalogEntry, batches: SatelliteBatches, sampler: TrajectorySampler, passes: PassPredictorSource) {
    this.viewer = viewer;
    this.props = new SatelliteProperties(entry, sampler, passes);
    this.#orbits = batches.orbits;
    this.#tracks = batches.tracks;
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

  #batchFor(name: SatelliteComponentName): PolylineBatch {
    return name === "Orbit track" ? this.#tracks : this.#orbits;
  }

  get components(): Record<string, Component> {
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
      () => !this.#modelPending(),
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCesiumEntity(componentName: string, entityKey: string, entityValue: any, name: string, position: any, moving: boolean): void {
    const entity = new Entity({
      name,
      position,
      viewFrom: this.#viewFrom(),
    });
    if (moving) {
      entity.orientation = new VelocityOrientationProperty(position);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entity as any)[entityKey] = entityValue;
    this.#components[componentName] = entity;
  }

  enableComponent(name: SatelliteComponentName): void {
    if (!this.created) {
      this.init();
    }
    if (!this.props.trajectory.valid) {
      console.error(`No valid position data available for ${this.props.name}`);
      return;
    }
    if (!(name in this.#components)) {
      this.createComponent(name);
      this.updatedSampledPositionForComponents();
    }

    const component = this.#components[name];
    if (component instanceof Entity) {
      if (!this.viewer.entities.contains(component)) {
        this.viewer.entities.add(component);
      }
      this.defaultEntity ??= component;
    } else if (component instanceof GeometryInstance) {
      this.#batchFor(name).add(component);
    }

    if (name === "3D model" && component) {
      this.#setViewFrom();
    }
  }

  disableComponent(name: SatelliteComponentName): void {
    const component = this.#components[name];
    if (component instanceof Entity) {
      this.viewer.entities.remove(component);
    } else if (component instanceof GeometryInstance) {
      this.#batchFor(name).remove(component);
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

  #viewFrom(): Cartesian3 | CallbackProperty {
    return "3D model" in this.#components ? this.#modelViewFrom : VIEW_FROM;
  }

  /**
   * A callback: the model's size is known only once loaded, and EntityView reads it when tracking starts.
   */
  readonly #modelViewFrom = new CallbackProperty(
    (_time, result?: Cartesian3) => Cartesian3.multiplyByScalar(VIEW_FROM_MODEL_DIRECTION, VIEW_FROM_MODEL_RADII * this.#modelRadius(), result ?? new Cartesian3()),
    false,
  );

  /**
   * The scale at which the model is its minimum size from the default view's distance,
   * so further out it shrinks with the globe. A fixed 10,000x held a cubesat under a
   * pixel at the default view.
   */
  #modelMaximumScale(): number | undefined {
    const { camera, canvas, globe } = this.viewer.scene;
    if (!(camera.frustum instanceof PerspectiveFrustum) || camera.frustum.fov === undefined || canvas.clientHeight === 0) {
      return undefined;
    }
    const distance = defaultViewDistance(camera.frustum.fov, canvas.clientWidth / canvas.clientHeight, globe.ellipsoid.maximumRadius);
    const pixel = camera.frustum.getPixelDimensions(canvas.clientWidth, canvas.clientHeight, distance, 1, SatelliteComponentCollection.#pixelScratch);
    const diameter = 2 * this.#modelRadius();
    return (modelMinimumPixelSize(diameter) * Math.max(pixel.x, pixel.y)) / diameter;
  }

  /** How wide Cesium draws the model's bounding sphere, in CSS pixels; undefined while it is not drawn. */
  #modelPixelDiameter(): number | undefined {
    if (this.#modelState() !== "ready") {
      return undefined;
    }
    const sphere = SatelliteComponentCollection.#sphereScratch;
    const diameter = 2 * sphere.radius;
    const { scene } = this.viewer;
    const metresPerPixel = scene.camera.getPixelSize(sphere, scene.drawingBufferWidth, scene.drawingBufferHeight);
    const scale = Math.min(Math.max(1, (modelMinimumPixelSize(diameter) * metresPerPixel) / diameter), this.#modelMaximumScale() ?? Infinity);
    return (scale * diameter) / metresPerPixel;
  }

  #modelPending(): boolean {
    return this.#modelState() === "loading";
  }

  #modelRadius(): number {
    return this.#modelState() === "ready" ? SatelliteComponentCollection.#sphereScratch.radius : FALLBACK_MODEL_RADIUS;
  }

  /** "ready" leaves the model's bounding sphere in #sphereScratch. */
  #modelState(): "none" | "loading" | "ready" | "failed" {
    const model = this.#components["3D model"];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const display = this.viewer.dataSourceDisplay as any;
    if (!(model instanceof Entity) || typeof display?.getBoundingSphere !== "function") {
      return "none";
    }
    try {
      const state = display.getBoundingSphere(model, false, SatelliteComponentCollection.#sphereScratch);
      return state === BOUNDING_SPHERE_DONE ? "ready" : state === BOUNDING_SPHERE_PENDING ? "loading" : "failed";
    } catch {
      // Cesium throws, rather than answering PENDING, for an entity added since its last update.
      return "loading";
    }
  }

  /** Read when tracking starts, so a camera already following the satellite stays put. */
  #setViewFrom(): void {
    for (const component of Object.values(this.#components)) {
      if (component instanceof Entity) {
        component.viewFrom = this.#viewFrom() as unknown as typeof component.viewFrom;
      }
    }
  }

  init(): void {
    this.eventListeners.sampledPosition = this.props.trajectory.start(this.viewer, () => {
      this.updatedSampledPositionForComponents(true);
    });

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
      if ("Orbit" in this.components && !this.isCorrectOrbitComponent()) {
        // A geometry cannot change visualisation type in place.
        this.disableComponent("Orbit");
        this.enableComponent("Orbit");
      }
      if ("Orbit track" in this.components && !this.isCorrectOrbitTrackComponent()) {
        this.disableComponent("Orbit track");
        this.enableComponent("Orbit track");
      }
    });
  }

  deinit(): void {
    // Iterate rather than name them, so a listener added to `init` cannot leak.
    Object.values(this.eventListeners).forEach((remove) => remove?.());
    this.eventListeners = {};
    cancelPendingTrack(this.viewer, this);
  }

  /** Idempotent: disabling the last component calls `deinit()`. */
  dispose(): void {
    this.hide();
  }

  updatedSampledPositionForComponents(update = false): void {
    const { entityPosition } = this.props.trajectory;
    // Not the inertial frame or the sampled property: both exist only when a component asks.
    if (!entityPosition) return;

    Object.entries(this.components).forEach(([type, component]) => {
      if (type === "Orbit") {
        if (component instanceof Entity) {
          // An Orbit exists, so createOrbit has already required the frame.
          this.props.trajectory.requireInertial();
          component.position = this.props.trajectory.inertial;
        } else if (update && component instanceof GeometryInstance) {
          // A geometry cannot be edited in place.
          this.disableComponent("Orbit");
          this.enableComponent("Orbit");
        }
      } else if (type === "Orbit track") {
        if (component instanceof Entity) {
          // A path needs the sampled property, not the grid.
          this.props.trajectory.requireSampled();
          component.position = this.props.trajectory.fixed;
        } else if (update) {
          // The sample window moved; re-cut with replace() rather than rebuild the membership.
          this.refreshOrbitTrack(this.viewer.clock.currentTime);
        }
      } else if (component instanceof Entity) {
        if (type === "Sensor cone") {
          component.position = entityPosition;
          component.orientation = new CallbackProperty((time?: JulianDate) => coneOrientation(this.props.trajectory.position(time as JulianDate)), false);
        } else {
          component.position = entityPosition;
          component.orientation = new VelocityOrientationProperty(entityPosition);
        }
      }
    });
    // Request a single frame after satellite position updates when the clock is paused
    if (!this.viewer.clock.shouldAnimate) {
      const removeCallback = this.viewer.clock.onTick.addEventListener(() => {
        this.viewer.scene.requestRender();
        removeCallback();
      });
    }
  }

  createComponent(name: SatelliteComponentName): void {
    const create = (CREATORS as Record<string, ((sat: SatelliteComponentCollection) => void) | undefined>)[name];
    if (!create) {
      console.error(`Unknown component ${name}`);
      return;
    }
    create(this);
  }

  /**
   * An entity positioned by the grid property. Not for path graphics: Cesium
   * sub-samples densely only a `SampledPositionProperty`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createCesiumSatelliteEntity(entityName: string, entityKey: string, entityValue: any): void {
    this.createCesiumEntity(entityName, entityKey, entityValue, this.props.name, this.props.trajectory.entityPosition, true);
  }

  /**
   * Coloured like the satellite browser's orbit badge. At 6 px a full Starlink
   * activation hides the globe; the outline keeps points visible on bright imagery.
   */
  createPoint(): void {
    const point = new PointGraphics({
      pixelSize: 5,
      color: POINT_COLOR[this.props.orbitClass],
      outlineColor: Color.DIMGREY,
      outlineWidth: 1,
      ...(this.props.entry.metadata.modelFile && {
        show: new CallbackProperty(() => (this.#modelPixelDiameter() ?? 0) < MODEL_MARKER_PIXELS, false),
      }),
    });
    this.createCesiumSatelliteEntity("Point", "point", point);
  }

  /** Only satellites a model manifest lists have one (ADR 0007). */
  createModel(): void {
    const { modelFile } = this.props.entry.metadata;
    if (!modelFile) {
      return;
    }
    const model = new ModelGraphics({
      uri: modelUrl(modelFile),
      minimumPixelSize: new CallbackProperty(() => modelMinimumPixelSize(2 * this.#modelRadius()), false),
      maximumScale: new CallbackProperty(() => this.#modelMaximumScale(), false),
    });
    this.createCesiumSatelliteEntity("3D model", "model", model);
  }

  /** The LEO point's grey, not white: white labels outshouted the points they named. */
  createLabel(): void {
    const label = new LabelGraphics({
      text: this.props.name,
      font: "13px Arial",
      fillColor: POINT_COLOR.LEO,
      style: LabelStyle.FILL_AND_OUTLINE,
      outlineColor: Color.DIMGREY,
      outlineWidth: 2,
      horizontalOrigin: HorizontalOrigin.LEFT,
      pixelOffset: this.props.entry.metadata.modelFile
        ? new CallbackProperty(
            (_time, result?: Cartesian2) => Cartesian2.fromElements(Math.max(LABEL_OFFSET, (this.#modelPixelDiameter() ?? 0) / 2 + LABEL_MODEL_GAP), 0, result),
            false,
          )
        : new Cartesian2(LABEL_OFFSET, 0),
      distanceDisplayCondition: new DistanceDisplayCondition(2000, 8e7),
      translucencyByDistance: new NearFarScalar(6e7, 1.0, 8e7, 0.0),
    });
    this.createCesiumSatelliteEntity("Label", "label", label);
  }

  createOrbit(): void {
    // The Orbit is the only component drawn in the inertial frame.
    this.props.trajectory.requireInertial();
    if (this.usePathGraphicForOrbit) {
      this.createOrbitPath();
    } else {
      this.createOrbitPolylineGeometry();
    }
  }

  isCorrectOrbitComponent(): boolean {
    return this.usePathGraphicForOrbit ? this.components.Orbit instanceof Entity : this.components.Orbit instanceof GeometryInstance;
  }

  get usePathGraphicForOrbit(): boolean {
    return orbitUsesPathGraphic(this.isTracked, this.viewer.scene.mode === SceneMode.SCENE3D);
  }

  createOrbitPath(): void {
    const path = new PathGraphics({
      ...orbitPathTimes(this.props.orbit.orbitalPeriod),
      material: Color.WHITE.withAlpha(0.15),
      resolution: 600,
      width: ORBIT_WIDTH,
    });
    this.createCesiumEntity("Orbit", "path", path, this.props.name, this.props.trajectory.inertial, true);
  }

  /** How every untracked orbit is drawn in 3D. */
  createOrbitPolylineGeometry(): void {
    const positions = this.props.trajectory.positionsForNextOrbit(this.viewer.clock.currentTime);
    if (positions.length < MIN_POLYLINE_POSITIONS) {
      return;
    }
    const geometryInstance = new GeometryInstance({
      geometry: new PolylineGeometry({
        positions,
        width: ORBIT_WIDTH,
        arcType: ArcType.NONE,
        vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(new Color(1.0, 1.0, 1.0, 0.15)),
      },
      id: this.props.name,
    });
    this.components.Orbit = geometryInstance;
  }

  createOrbitTrack(): void {
    if (this.usePathGraphicForOrbitTrack) {
      this.createOrbitTrackPath();
    } else {
      this.createOrbitTrackPolylineGeometry();
    }
  }

  isCorrectOrbitTrackComponent(): boolean {
    return this.usePathGraphicForOrbitTrack ? this.components["Orbit track"] instanceof Entity : this.components["Orbit track"] instanceof GeometryInstance;
  }

  get usePathGraphicForOrbitTrack(): boolean {
    return orbitUsesPathGraphic(this.isTracked, this.viewer.scene.mode === SceneMode.SCENE3D);
  }

  /** Resampled every frame by PathVisualizer, about 60 µs each, so only for the tracked satellite. */
  createOrbitTrackPath(): void {
    const path = new PathGraphics({
      ...orbitTrackTimes(this.props.orbit.orbitalPeriod),
      material: Color.GOLD.withAlpha(0.15),
      resolution: 600,
      width: ORBIT_WIDTH,
    });
    // The sampled property, so PathVisualizer sub-samples at the stored sample
    // times rather than at `resolution`.
    this.props.trajectory.requireSampled();
    this.createCesiumEntity("Orbit track", "path", path, this.props.name, this.props.trajectory.fixed, true);
  }

  /** How every untracked track is drawn in 3D. */
  createOrbitTrackPolylineGeometry(): void {
    const geometry = this.#orbitTrackGeometry(this.viewer.clock.currentTime);
    if (geometry) {
      this.components["Orbit track"] = geometry;
    }
  }

  #orbitTrackGeometry(time: JulianDate): GeometryInstance | undefined {
    const positions = this.props.trajectory.positionsForTrack(time);
    if (positions.length < MIN_POLYLINE_POSITIONS) {
      return undefined;
    }
    return new GeometryInstance({
      geometry: new PolylineGeometry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        positions: positions as any,
        width: ORBIT_WIDTH,
        arcType: ArcType.NONE,
        vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(Color.GOLD.withAlpha(0.15)),
      },
      id: this.props.name,
    });
  }

  /**
   * Re-cut the batched track so its head sits back on the satellite. No model
   * matrix keeps a fixed-frame track current. The batch coalesces every
   * `replace` into one primitive rebuild.
   */
  refreshOrbitTrack(time: JulianDate): void {
    const current = this.#components["Orbit track"];
    if (!(current instanceof GeometryInstance)) {
      return;
    }
    const next = this.#orbitTrackGeometry(time);
    if (next && this.#tracks.replace(current, next)) {
      this.#components["Orbit track"] = next;
    }
  }

  /**
   * Constant positions re-assigned by `refreshGroundTrack`, not a CallbackProperty:
   * a non-constant property puts the corridor on Cesium's dynamic-geometry path,
   * which re-tessellates every frame at about 90 µs per corridor.
   */
  createGroundTrack(): void {
    const description = groundTrackDescription(this.props.orbitClass, this.props.swath);
    if (!description) {
      return;
    }
    const positions = this.#groundTrackPositions(this.viewer.clock.currentTime);
    // A corridor Cesium cannot build takes the render loop down with it.
    if (positions.length < 2) {
      return;
    }
    const corridor = new CorridorGraphics({
      cornerType: CornerType.MITERED,
      height: 1000,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      material: Color.DARKRED.withAlpha(0.25),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      positions: positions as any,
      width: description.widthMeters,
    });
    this.createCesiumSatelliteEntity("Ground track", "corridor", corridor);
  }

  /**
   * Outside the sample window `GridPositionProperty` clamps to the edge sample,
   * so the duplicates `drawablePositions` drops do arrive.
   */
  #groundTrackPositions(time: JulianDate): Cartesian3[] {
    return drawablePositions(this.props.trajectory.groundTrack(time));
  }

  /** See createGroundTrack. */
  refreshGroundTrack(time: JulianDate): void {
    const entity = this.#components["Ground track"];
    if (!(entity instanceof Entity) || !entity.corridor) {
      return;
    }
    const positions = this.#groundTrackPositions(time);
    if (positions.length < 2) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entity.corridor.positions = positions as any;
  }

  /**
   * Whether the drawn corridor has caught up with its last positions; undefined
   * without a ground track or without `getBoundingSphere`. That private Cesium
   * method reports PENDING while the batch primitive is unfinished.
   */
  groundTrackSettled(): boolean | undefined {
    const entity = this.#components["Ground track"];
    if (!(entity instanceof Entity) || !entity.corridor) {
      return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const display = this.viewer.dataSourceDisplay as any;
    if (typeof display?.getBoundingSphere !== "function") {
      SatelliteComponentCollection.#reportMissingBoundingSphere();
      return undefined;
    }
    return display.getBoundingSphere(entity, false, SatelliteComponentCollection.#sphereScratch) !== BOUNDING_SPHERE_PENDING;
  }

  createCone(fov = this.props.coneFovDeg): void {
    const description = coneDescription(this.props.orbitClass, fov);
    if (!description) {
      return;
    }
    const entity = new Entity();
    entity.addProperty("conicSensor");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (entity as any).conicSensor = new CesiumSensorVolumes.ConicSensorGraphics({
      radius: description.radiusMeters,
      innerHalfAngle: description.innerHalfAngleRad,
      outerHalfAngle: description.outerHalfAngleRad,
      lateralSurfaceMaterial: Color.GOLD.withAlpha(0.15),
      intersectionColor: Color.GOLD.withAlpha(0.3),
      intersectionWidth: 1,
    });
    this.components["Sensor cone"] = entity;
  }

  createGroundStationLink(): void {
    const polyline = new PolylineGraphics({
      material: new PolylineGlowMaterialProperty({
        glowPower: 0.5,
        color: Color.FORESTGREEN,
      }),
      positions: new CallbackProperty((time?: JulianDate) => {
        const satPosition = this.props.trajectory.position(time as JulianDate);
        const groundPosition = this.activeGroundStationCartesian(time as JulianDate);
        return [satPosition, groundPosition];
      }, false),
      // Reading the passes keeps their window around the clock for an unselected satellite.
      show: new CallbackProperty((time?: JulianDate) => {
        this.props.passPredictor.passes(time as JulianDate);
        return this.props.passPredictor.passIntervals.contains(time as JulianDate);
      }, false),
      width: 5,
    });
    this.createCesiumSatelliteEntity("Ground station link", "polyline", polyline);
  }

  /** The station of the pass containing `time`, else the first station. */
  private activeGroundStationCartesian(time: JulianDate): Cartesian3 | undefined {
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
