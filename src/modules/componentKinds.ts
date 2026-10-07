// What each component kind is: how it is created, follows the trajectory, is re-cut as
// time passes, and which representation fits the scene. The satellite's collection
// (SatelliteComponentCollection) holds them and asks; it knows no kind by name.

import {
  ArcType,
  BoundingSphere,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CornerType,
  CorridorGraphics,
  DistanceDisplayCondition,
  Entity,
  GeometryInstance,
  HeightReference,
  HorizontalOrigin,
  type JulianDate,
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
  SceneMode,
  VelocityOrientationProperty,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import CesiumSensorVolumes from "cesium-sensor-volumes";

import type { SATELLITE_COMPONENTS } from "../config/components";
import { defaultViewDistance } from "../config/defaultView";
import { ORBIT_CLASS_COLOR, type OrbitClass } from "../config/orbitClass";
import { coneDescription, coneOrientation, groundTrackDescription, modelUrl, orbitPathTimes, orbitTrackTimes, orbitUsesPathGraphic } from "./satelliteGraphics";
import type { SatelliteProperties } from "./SatelliteProperties";
import { drawable } from "./util/drawablePositions";
import type { PolylineBatch } from "./util/PolylineBatch";

/** A GeometryInstance when merged into a shared orbit batch. */
export type Component = Entity | GeometryInstance;

export type ComponentName = (typeof SATELLITE_COMPONENTS)[number];

/** The shared polyline batches a satellite draws its orbit lines into. */
export interface SatelliteBatches {
  /** Inertial: the Orbit component's closed ellipse. */
  orbits: PolylineBatch;
  /** Fixed: the Orbit track component's Earth-relative path. */
  tracks: PolylineBatch;
}

/** What a kind may ask of the satellite it draws. */
export interface ComponentHost {
  readonly viewer: Viewer;
  readonly props: SatelliteProperties;
  readonly batches: SatelliteBatches;
  readonly isTracked: boolean;
  readonly model: ModelSize;
  /** An entity named after the satellite, framed for tracking. */
  entity(key: string, graphics: unknown, position: unknown, moving: boolean): Entity;
  /** The station of the pass containing `time`, else the first station. */
  groundStationAt(time: JulianDate): Cartesian3 | undefined;
}

/** A kind of component. Every method but `create` is optional. */
export interface ComponentKind {
  /** Undefined when the satellite cannot draw it: no model file, not LEO, too few positions. */
  create(host: ComponentHost): Component | undefined;
  /** The batch a GeometryInstance of this kind is drawn into. */
  batch?(host: ComponentHost): PolylineBatch;
  /**
   * Binds the component to the trajectory's current properties, once on creation and
   * after every top-up (`refilled`). "recreate" when it cannot follow in place, "recut"
   * when it follows by `recut`.
   */
  bind(component: Component, host: ComponentHost, refilled: boolean): "recreate" | "recut" | void;
  /** Cut anew as simulation time passes. Returns what is drawn now. */
  recut?(component: Component, host: ComponentHost, time: JulianDate): Component;
  /** Whether the component still suits the scene mode and the tracking, else it is recreated. */
  fits?(component: Component, host: ComponentHost): boolean;
  /** Whether the drawn component has caught up with its last positions; undefined if it cannot say. */
  settled?(component: Component, host: ComponentHost): boolean | undefined;
}

/** Converted once and shared by every point, like Cesium's own Color constants. */
const POINT_COLOR = Object.fromEntries(Object.entries(ORBIT_CLASS_COLOR).map(([orbitClass, hex]) => [orbitClass, Color.fromCssColorString(hex)])) as Record<OrbitClass, Color>;

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

/** For a model not loaded yet: a small satellite's. */
const FALLBACK_MODEL_RADIUS = 2.5;

/** `BoundingSphereState.PENDING`, which the engine's type declarations do not export. */
const BOUNDING_SPHERE_PENDING = 1;
const BOUNDING_SPHERE_DONE = 0;

/**
 * The smallest a model is drawn, in css pixels, by its bounding-sphere diameter in
 * metres: a cubesat at 20, Landsat at 55, the ISS at 72. A cube root, not a log: a
 * log drew a compact cubesat as large as Landsat.
 */
export function modelMinimumPixelSize(diameter: number): number {
  return Math.min(72, Math.max(20, 23 * Math.cbrt(diameter)));
}

/** `DataSourceDisplay.getBoundingSphere`, which Cesium marks private. */
type BoundingSphereLookup = (entity: Entity, allowPartial: boolean, result: BoundingSphere) => number;

function boundingSphereLookup(viewer: Viewer): BoundingSphereLookup | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const display = viewer.dataSourceDisplay as any;
  return typeof display?.getBoundingSphere === "function" ? (display.getBoundingSphere.bind(display) as BoundingSphereLookup) : undefined;
}

let reportedMissingBoundingSphere = false;

const settledScratch = new BoundingSphere();

function reportMissingBoundingSphere(): void {
  if (reportedMissingBoundingSphere) {
    return;
  }
  reportedMissingBoundingSphere = true;
  console.error("Cesium DataSourceDisplay has no getBoundingSphere; pacing ground tracks on a fixed schedule instead. Cesium internals have moved — see groundTrackSettled.");
}

/** How large a satellite's 3D model is drawn, which its point, label and tracking defer to. */
export class ModelSize {
  static readonly #sphereScratch = new BoundingSphere();
  static readonly #pixelScratch = new Cartesian2();

  readonly #viewer: Viewer;

  readonly #model: () => Component | undefined;

  constructor(viewer: Viewer, model: () => Component | undefined) {
    this.#viewer = viewer;
    this.#model = model;
  }

  /** "ready" leaves the model's bounding sphere in #sphereScratch. */
  state(): "none" | "loading" | "ready" | "failed" {
    const model = this.#model();
    const lookup = boundingSphereLookup(this.#viewer);
    if (!(model instanceof Entity) || !lookup) {
      return "none";
    }
    try {
      const state = lookup(model, false, ModelSize.#sphereScratch);
      return state === BOUNDING_SPHERE_DONE ? "ready" : state === BOUNDING_SPHERE_PENDING ? "loading" : "failed";
    } catch {
      // Cesium throws, rather than answering PENDING, for an entity added since its last update.
      return "loading";
    }
  }

  get pending(): boolean {
    return this.state() === "loading";
  }

  radius(): number {
    return this.state() === "ready" ? ModelSize.#sphereScratch.radius : FALLBACK_MODEL_RADIUS;
  }

  /**
   * The scale at which the model is its minimum size from the default view's distance,
   * so further out it shrinks with the globe. A fixed 10,000x held a cubesat under a
   * pixel at the default view.
   */
  maximumScale(): number | undefined {
    const { camera, canvas, globe } = this.#viewer.scene;
    if (!(camera.frustum instanceof PerspectiveFrustum) || camera.frustum.fov === undefined || canvas.clientHeight === 0) {
      return undefined;
    }
    const distance = defaultViewDistance(camera.frustum.fov, canvas.clientWidth / canvas.clientHeight, globe.ellipsoid.maximumRadius);
    const pixel = camera.frustum.getPixelDimensions(canvas.clientWidth, canvas.clientHeight, distance, 1, ModelSize.#pixelScratch);
    const diameter = 2 * this.radius();
    return (modelMinimumPixelSize(diameter) * Math.max(pixel.x, pixel.y)) / diameter;
  }

  /** How wide Cesium draws the model's bounding sphere, in CSS pixels; undefined while it is not drawn. */
  pixelDiameter(): number | undefined {
    if (this.state() !== "ready") {
      return undefined;
    }
    const sphere = ModelSize.#sphereScratch;
    const diameter = 2 * sphere.radius;
    const { scene } = this.#viewer;
    const metresPerPixel = scene.camera.getPixelSize(sphere, scene.drawingBufferWidth, scene.drawingBufferHeight);
    const scale = Math.min(Math.max(1, (modelMinimumPixelSize(diameter) * metresPerPixel) / diameter), this.maximumScale() ?? Infinity);
    return (scale * diameter) / metresPerPixel;
  }
}

/** Follows the satellite, facing along its velocity. */
function bindAtSatellite(component: Component, host: ComponentHost): void {
  const position = host.props.trajectory.entityPosition;
  if (component instanceof Entity && position) {
    component.position = position as typeof component.position;
    component.orientation = new VelocityOrientationProperty(position) as unknown as typeof component.orientation;
  }
}

/** An entity at the satellite, positioned by the grid property. Not for path graphics: Cesium sub-samples densely only a `SampledPositionProperty`. */
function atSatellite(host: ComponentHost, key: string, graphics: unknown): Entity {
  return host.entity(key, graphics, host.props.trajectory.entityPosition, true);
}

/** The tracked satellite's lines are paths, which follow it; outside 3D every one is, as a batch draws only there. */
function drawnAsPath(host: ComponentHost): boolean {
  return orbitUsesPathGraphic(host.isTracked, host.viewer.scene.mode === SceneMode.SCENE3D);
}

function fitsDrawing(component: Component, host: ComponentHost): boolean {
  return drawnAsPath(host) ? component instanceof Entity : component instanceof GeometryInstance;
}

function polylineInstance(positions: Cartesian3[], color: Color, id: string): GeometryInstance {
  return new GeometryInstance({
    geometry: new PolylineGeometry({
      positions,
      width: ORBIT_WIDTH,
      arcType: ArcType.NONE,
      vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
    }),
    attributes: {
      color: ColorGeometryInstanceAttribute.fromColor(color),
    },
    id,
  });
}

function orbitTrackInstance(host: ComponentHost, time: JulianDate): GeometryInstance | undefined {
  const positions = drawable(host.props.trajectory.positionsForTrack(time));
  return positions && polylineInstance(positions, Color.GOLD.withAlpha(0.15), host.props.name);
}

/**
 * Outside the sample window `GridPositionProperty` clamps to the edge sample, so the
 * duplicates `drawable` drops do arrive.
 */
function groundTrackPositions(host: ComponentHost, time: JulianDate): Cartesian3[] | undefined {
  return drawable(host.props.trajectory.groundTrack(time));
}

/** Keyed by the config list, so a component without a kind is a compile error. */
export const COMPONENT_KINDS: Record<ComponentName, ComponentKind> = {
  /**
   * Coloured like the satellite browser's orbit badge. At 6 px a full Starlink
   * activation hides the globe; the outline keeps points visible on bright imagery.
   */
  Point: {
    create: (host) =>
      atSatellite(
        host,
        "point",
        new PointGraphics({
          pixelSize: 5,
          color: POINT_COLOR[host.props.orbitClass],
          outlineColor: Color.DIMGREY,
          outlineWidth: 1,
          ...(host.props.entry.metadata.modelFile && {
            show: new CallbackProperty(() => (host.model.pixelDiameter() ?? 0) < MODEL_MARKER_PIXELS, false),
          }),
        }),
      ),
    bind: bindAtSatellite,
  },

  /** The LEO point's grey, not white: white labels outshouted the points they named. */
  Label: {
    create: (host) =>
      atSatellite(
        host,
        "label",
        new LabelGraphics({
          text: host.props.name,
          font: "13px Arial",
          fillColor: POINT_COLOR.LEO,
          style: LabelStyle.FILL_AND_OUTLINE,
          outlineColor: Color.DIMGREY,
          outlineWidth: 2,
          horizontalOrigin: HorizontalOrigin.LEFT,
          pixelOffset: host.props.entry.metadata.modelFile
            ? new CallbackProperty(
                (_time, result?: Cartesian2) => Cartesian2.fromElements(Math.max(LABEL_OFFSET, (host.model.pixelDiameter() ?? 0) / 2 + LABEL_MODEL_GAP), 0, result),
                false,
              )
            : new Cartesian2(LABEL_OFFSET, 0),
          distanceDisplayCondition: new DistanceDisplayCondition(2000, 8e7),
          translucencyByDistance: new NearFarScalar(6e7, 1.0, 8e7, 0.0),
        }),
      ),
    bind: bindAtSatellite,
  },

  /** The only component drawn in the inertial frame. Batched in 3D, a path otherwise and for the tracked satellite. */
  Orbit: {
    create: (host) => {
      const { trajectory } = host.props;
      trajectory.requireInertial();
      if (drawnAsPath(host)) {
        const path = new PathGraphics({
          ...orbitPathTimes(host.props.orbit.orbitalPeriod),
          material: Color.WHITE.withAlpha(0.15),
          resolution: 600,
          width: ORBIT_WIDTH,
        });
        return host.entity("path", path, trajectory.inertial, true);
      }
      const positions = drawable(trajectory.positionsForNextOrbit(host.viewer.clock.currentTime));
      return positions && polylineInstance(positions, new Color(1.0, 1.0, 1.0, 0.15), host.props.name);
    },
    batch: (host) => host.batches.orbits,
    bind: (component, host, refilled) => {
      if (component instanceof Entity) {
        // An Orbit exists, so `create` has already required the frame.
        host.props.trajectory.requireInertial();
        component.position = host.props.trajectory.inertial;
        return undefined;
      }
      // A geometry cannot be edited in place.
      return refilled ? "recreate" : undefined;
    },
    fits: fitsDrawing,
  },

  /** Earth-fixed, one period ahead. Batched like the Orbit. */
  "Orbit track": {
    create: (host) => {
      if (drawnAsPath(host)) {
        // Resampled every frame by PathVisualizer, about 60 µs each, so only for the
        // tracked satellite. The sampled property, so PathVisualizer sub-samples at
        // the stored sample times rather than at `resolution`.
        const path = new PathGraphics({
          ...orbitTrackTimes(host.props.orbit.orbitalPeriod),
          material: Color.GOLD.withAlpha(0.15),
          resolution: 600,
          width: ORBIT_WIDTH,
        });
        host.props.trajectory.requireSampled();
        return host.entity("path", path, host.props.trajectory.fixed, true);
      }
      return orbitTrackInstance(host, host.viewer.clock.currentTime);
    },
    batch: (host) => host.batches.tracks,
    bind: (component, host, refilled) => {
      if (component instanceof Entity) {
        // A path needs the sampled property, not the grid.
        host.props.trajectory.requireSampled();
        component.position = host.props.trajectory.fixed;
        return undefined;
      }
      // The sample window moved: re-cut with replace() rather than rebuild the membership.
      return refilled ? "recut" : undefined;
    },
    /**
     * Puts the batched track's head back on the satellite. No model matrix keeps a
     * fixed-frame track current. The batch coalesces every `replace` into one
     * primitive rebuild.
     */
    recut: (component, host, time) => {
      if (!(component instanceof GeometryInstance)) {
        return component;
      }
      const next = orbitTrackInstance(host, time);
      return next && host.batches.tracks.replace(component, next) ? next : component;
    },
    fits: fitsDrawing,
  },

  /**
   * Constant positions re-assigned by `recut`, not a CallbackProperty: a non-constant
   * property puts the corridor on Cesium's dynamic-geometry path, which re-tessellates
   * every frame at about 90 µs per corridor.
   */
  "Ground track": {
    create: (host) => {
      const description = groundTrackDescription(host.props.orbitClass, host.props.swath);
      const positions = description && groundTrackPositions(host, host.viewer.clock.currentTime);
      if (!description || !positions) {
        return undefined;
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
      return atSatellite(host, "corridor", corridor);
    },
    bind: bindAtSatellite,
    recut: (component, host, time) => {
      const positions = component instanceof Entity && component.corridor ? groundTrackPositions(host, time) : undefined;
      if (component instanceof Entity && component.corridor && positions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        component.corridor.positions = positions as any;
      }
      return component;
    },
    /** That private Cesium method reports PENDING while the batch primitive is unfinished. */
    settled: (component, host) => {
      if (!(component instanceof Entity) || !component.corridor) {
        return undefined;
      }
      const lookup = boundingSphereLookup(host.viewer);
      if (!lookup) {
        reportMissingBoundingSphere();
        return undefined;
      }
      return lookup(component, false, settledScratch) !== BOUNDING_SPHERE_PENDING;
    },
  },

  "Sensor cone": {
    create: (host) => {
      const description = coneDescription(host.props.orbitClass, host.props.coneFovDeg);
      if (!description) {
        return undefined;
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
      return entity;
    },
    bind: (component, host) => {
      const { trajectory } = host.props;
      if (component instanceof Entity && trajectory.entityPosition) {
        component.position = trajectory.entityPosition as typeof component.position;
        component.orientation = new CallbackProperty(
          (time?: JulianDate) => coneOrientation(trajectory.position(time as JulianDate)),
          false,
        ) as unknown as typeof component.orientation;
      }
    },
  },

  /** Only satellites a model manifest lists have one (ADR 0007). */
  "3D model": {
    create: (host) => {
      const { modelFile } = host.props.entry.metadata;
      if (!modelFile) {
        return undefined;
      }
      const model = new ModelGraphics({
        uri: modelUrl(modelFile),
        minimumPixelSize: new CallbackProperty(() => modelMinimumPixelSize(2 * host.model.radius()), false),
        maximumScale: new CallbackProperty(() => host.model.maximumScale(), false),
      });
      return atSatellite(host, "model", model);
    },
    bind: bindAtSatellite,
  },

  "Ground station link": {
    create: (host) => {
      const { trajectory, passPredictor } = host.props;
      const polyline = new PolylineGraphics({
        material: new PolylineGlowMaterialProperty({
          glowPower: 0.5,
          color: Color.FORESTGREEN,
        }),
        positions: new CallbackProperty((time?: JulianDate) => [trajectory.position(time as JulianDate), host.groundStationAt(time as JulianDate)], false),
        // Reading the passes keeps their window around the clock for an unselected satellite.
        show: new CallbackProperty((time?: JulianDate) => {
          passPredictor.passes(time as JulianDate);
          return passPredictor.passIntervals.contains(time as JulianDate);
        }, false),
        width: 5,
      });
      return atSatellite(host, "polyline", polyline);
    },
    bind: bindAtSatellite,
  },
};

/** Drawn into a shared batch in 3D, so a scene morph has to recreate them. */
export const BATCHED_COMPONENTS = (Object.keys(COMPONENT_KINDS) as ComponentName[]).filter((name) => COMPONENT_KINDS[name].batch !== undefined);

export function componentKind(name: string): ComponentKind | undefined {
  return (COMPONENT_KINDS as Record<string, ComponentKind | undefined>)[name];
}
