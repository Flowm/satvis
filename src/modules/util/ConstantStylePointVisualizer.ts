// Cesium's PointVisualizer reads and writes all ten of a point's style properties for
// every point on every tick. Here a point whose style is constant only has its position
// written; Cesium's own update handles everything else: a point new, changed, hidden,
// clamped to the ground or styled by time.
//
// Measured in headless Chromium at 11,140 Starlink points: dataSourceDisplay.update spent
// 92% in PointVisualizer and the property reads under it, 8% interpolating positions.

import { Cartesian3, type JulianDate } from "@cesium/core";
import {
  DataSourceDisplay,
  type Entity,
  type EntityCluster,
  type EntityCollection,
  HeightReference,
  type PointGraphics,
  type PointPrimitive,
  PointVisualizer,
  type Property,
} from "@cesium/engine";

/** PointVisualizer's per-entity record, with whether the fast path may take it. */
interface Item {
  entity: Entity;
  pointPrimitive: PointPrimitive | undefined;
  constantStyle?: boolean;
}

/** The private fields of PointVisualizer this reads. */
interface PointVisualizerInternals {
  /** An AssociativeArray; Cesium's update reads only `values`. */
  _items: { values: Item[]; get?(id: string): Item | undefined };
  _cluster: EntityCluster & { _clusterDirty: boolean };
}

/** The style properties PointVisualizer reads every tick, `show` and the position aside. */
const STYLE_KEYS = [
  "_heightReference",
  "_scaleByDistance",
  "_translucencyByDistance",
  "_color",
  "_outlineColor",
  "_outlineWidth",
  "_pixelSize",
  "_distanceDisplayCondition",
  "_disableDepthTestDistance",
  "_splitDirection",
] as const;

/** Shared by every point: the primitive's position setter copies it. */
const positionScratch = new Cartesian3();

/** Whether no style property can change by itself, and the point is not drawn as a clamped billboard. */
function constantStyle(graphics: PointGraphics, time: JulianDate): boolean {
  const properties = graphics as unknown as Record<(typeof STYLE_KEYS)[number], Property | undefined>;
  return (
    STYLE_KEYS.every((key) => properties[key] === undefined || properties[key].isConstant) &&
    (properties._heightReference?.getValue(time) ?? HeightReference.NONE) === HeightReference.NONE
  );
}

/** A PointVisualizer that skips the style of a point whose style cannot change by itself. */
export class ConstantStylePointVisualizer extends PointVisualizer {
  /** The entities whose points this draws. */
  readonly #collection: EntityCollection;

  /** Points Cesium's update takes this tick, reused across ticks. */
  readonly #slow: Item[] = [];

  /** Draws the points of `collection`'s entities into `cluster`, as PointVisualizer does. */
  constructor(cluster: EntityCluster, collection: EntityCollection) {
    super(cluster, collection);
    this.#collection = collection;
    // Registered after the base class's listener, so a changed entity's item exists.
    collection.collectionChanged.addEventListener(this.#onCollectionChanged, this);
  }

  /** A changed entity may have new style properties, so it goes through Cesium's update once. */
  #onCollectionChanged(_collection: EntityCollection, _added: Entity[], _removed: Entity[], changed: Entity[]): void {
    const items = (this as unknown as PointVisualizerInternals)._items;
    for (const entity of changed) {
      const item = items.get?.(entity.id);
      if (item) {
        item.constantStyle = false;
      }
    }
  }

  /** Writes the position of each point whose style is constant, and has Cesium update the rest. */
  override update(time: JulianDate): boolean {
    const internals = this as unknown as PointVisualizerInternals;
    const all = internals._items;
    const cluster = internals._cluster;
    const slow = this.#slow;
    slow.length = 0;
    // Clustering hides and shows the points itself.
    const fast = !cluster.enabled;
    for (const item of all.values) {
      const pointPrimitive = item.pointPrimitive;
      if (!fast || !item.constantStyle || pointPrimitive === undefined) {
        slow.push(item);
        continue;
      }
      const entity = item.entity;
      const position = entity.isShowing && entity.isAvailable(time) && (entity.point!.show?.getValue(time) ?? true) ? entity.position?.getValue(time, positionScratch) : undefined;
      if (position === undefined) {
        // Hiding is Cesium's to do: it returns the primitive to the cluster.
        item.constantStyle = false;
        slow.push(item);
        continue;
      }
      if (!entity.position!.isConstant) {
        cluster._clusterDirty = true;
      }
      pointPrimitive.position = position;
    }
    if (slow.length > 0) {
      internals._items = { values: slow };
      try {
        super.update(time);
      } finally {
        internals._items = all;
      }
      for (const item of slow) {
        item.constantStyle = item.pointPrimitive !== undefined && constantStyle(item.entity.point!, time);
      }
    }
    return true;
  }

  /** Stops following the collection, and frees the points. */
  override destroy(): void {
    this.#collection.collectionChanged.removeEventListener(this.#onCollectionChanged, this);
    super.destroy();
  }
}

/** A second wrap would replace each of ours with another. */
let installed = false;

/** Has every DataSourceDisplay created from now on draw points with ConstantStylePointVisualizer. */
export function useConstantStylePoints(): void {
  if (installed) {
    return;
  }
  installed = true;
  // Typed as taking no arguments in Cesium's declarations.
  const display = DataSourceDisplay as unknown as { defaultVisualizersCallback: DataSourceDisplay.VisualizersCallback };
  const defaults = display.defaultVisualizersCallback;
  display.defaultVisualizersCallback = (scene, cluster, dataSource) =>
    defaults(scene, cluster, dataSource).map((visualizer) => {
      if (!(visualizer instanceof PointVisualizer)) {
        return visualizer;
      }
      visualizer.destroy();
      return new ConstantStylePointVisualizer(cluster, dataSource.entities);
    });
}
