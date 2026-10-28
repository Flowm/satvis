import { type BoundingSphere, type Cartesian2, Cartesian3, Color, JulianDate, Math as CesiumMath, Matrix3, PerspectiveFrustum } from "@cesium/core";
import { Entity, type Property, Transforms } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ModelLod } from "../config/satelliteMetadata";
import { modelMinimumPixelSize } from "./componentKinds";
import type { GroundStation } from "./PassPredictor";
import { CatalogEntry } from "./SatelliteCatalog";
import { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import { parseGpPayload, type GpRecord } from "./util/gp";
import { GroundTrackBatch } from "./util/GroundTrackBatch";
import { InlinePassSource } from "./util/passSource";
import { BatchedLine, PolylineBatch } from "./util/PolylineBatch";
import { InlineSampleSource } from "./util/sampleSource";

const LINK = "Ground station link";

const TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

const munich = (): GroundStation => ({ name: "Munich", position: { latitude: 48.14, longitude: 11.58, height: 0 } });

/** A viewer whose entities collection records what is added and removed. */
function fakeViewer() {
  const entities = new Set<unknown>();
  const postRender = new Set<() => void>();
  const ticks = new Set<() => void>();
  const trackedListeners = new Set<() => void>();
  const selectedListeners = new Set<() => void>();
  const removed: unknown[] = [];
  const viewer = {
    clock: {
      currentTime: JulianDate.fromIso8601("2018-12-08T00:00:00Z"),
      shouldAnimate: false,
      onTick: { addEventListener: (listener: () => void) => (ticks.add(listener), () => ticks.delete(listener)) },
    },
    scene: {
      requestRender: () => {},
      preRender: { addEventListener: () => () => {} },
      primitives: { add: () => {}, remove: () => true },
      mode: 3,
      // A desktop window: Cesium's 60° is then the horizontal angle.
      camera: {
        frustum: new PerspectiveFrustum({ fov: CesiumMath.toRadians(60), aspectRatio: 1400 / 900 }),
        getPixelSize: () => viewer.metresPerPixel,
      },
      canvas: { clientWidth: 1400, clientHeight: 900 },
      globe: { ellipsoid: { maximumRadius: 6378137 } },
      frameState: {},
      postRender: { addEventListener: (listener: () => void) => (postRender.add(listener), () => postRender.delete(listener)) },
    },
    camera: { cancelFlight: () => {} },
    render: () => [...postRender].forEach((listener) => listener()),
    entities: {
      add: (e: unknown) => entities.add(e) && e,
      remove: (e: unknown) => removed.push(e) && entities.delete(e),
      contains: (e: unknown) => entities.has(e),
    },
    selected: undefined as unknown,
    get selectedEntity() {
      return viewer.selected;
    },
    set selectedEntity(entity: unknown) {
      viewer.selected = entity;
      [...selectedListeners].forEach((listener) => listener());
    },
    tracked: undefined as unknown,
    get trackedEntity() {
      return viewer.tracked;
    },
    set trackedEntity(entity: unknown) {
      viewer.tracked = entity;
      [...trackedListeners].forEach((listener) => listener());
    },
    selectedEntityChanged: { addEventListener: (listener: () => void) => (selectedListeners.add(listener), () => selectedListeners.delete(listener)) },
    trackedEntityChanged: { addEventListener: (listener: () => void) => (trackedListeners.add(listener), () => trackedListeners.delete(listener)) },
    // A model measures `modelRadius` once loaded; until then Cesium reports PENDING (1).
    modelRadius: undefined as number | undefined,
    // Models still loading although `modelRadius` is set, and models that failed (FAILED, 2).
    loading: new Set<Entity>(),
    failed: new Set<Entity>(),
    // Metres per CSS pixel at the satellite; the default view's is 18.3 km on this canvas.
    metresPerPixel: 1000,
    dataSourceDisplay: {
      getBoundingSphere(entity: Entity, _partial: boolean, result: BoundingSphere): number {
        if (viewer.failed.has(entity)) {
          return 2;
        }
        if (viewer.modelRadius === undefined || viewer.loading.has(entity)) {
          return 1;
        }
        result.radius = viewer.modelRadius;
        return 0;
      },
    },
  };
  return { viewer: viewer as unknown as Viewer, entities, removed, tick: () => [...ticks].forEach((listener) => listener()) };
}

/**
 * The ISS, with the model its manifest entry gives it unless `modelFile` is null: as a
 * worker before `model` wrote it, `modelFile` alone, unless it has `lods`.
 */
async function setup({ modelFile = "ISS-(ZARYA).glb", lods }: { modelFile?: string | null; lods?: ModelLod[] } = {}) {
  const { viewer, entities, removed, tick } = fakeViewer();
  const record = parseGpPayload(TLE)[0] as GpRecord;
  if (modelFile !== null) {
    record.metadata = { modelFile, ...(lods && { model: { file: modelFile, lods } }) };
  }
  const entry = new CatalogEntry({ key: "25544|ISS", name: "ISS", nameUpper: "ISS", satnum: "25544", tags: [], record });
  const sampler = new InlineSampleSource().samplerFor(entry.satnum, entry.record);
  const predictor = new InlinePassSource().predictorFor(entry.name, entry.record);
  const batches = {
    orbits: new PolylineBatch(viewer, "inertial", Color.WHITE),
    tracks: new PolylineBatch(viewer, "fixed", Color.GOLD),
    groundTracks: new GroundTrackBatch(viewer),
  };
  const nowMs = JulianDate.toDate(viewer.clock.currentTime).getTime();
  const opening = (await sampler.samples(nowMs - 3600_000, nowMs + 3600_000))!;
  const sat = new SatelliteComponentCollection(viewer, entry, batches, sampler, predictor, opening);
  return {
    sat,
    viewer,
    entities,
    removed,
    tick,
    setModelRadius: (radius: number) => ((viewer as unknown as { modelRadius?: number }).modelRadius = radius),
    setMetresPerPixel: (metres: number) => ((viewer as unknown as { metresPerPixel: number }).metresPerPixel = metres),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SatelliteComponentCollection ground station link", () => {
  test("is not drawn for a ground station unless switched on", async () => {
    const { sat, entities } = await setup();
    sat.show(["Point"]);
    sat.groundStations = [munich()];

    expect(sat.componentNames).toEqual(["Point"]);
    expect([...entities].every((e) => !(e as Entity).polyline)).toBe(true);
  });

  test("once switched on, reaches the scene and shows only during a pass", async () => {
    const { sat, viewer, entities } = await setup();
    sat.groundStations = [munich()];
    sat.show(["Point", LINK]);

    const link = sat.components[LINK] as Entity;
    expect(entities.has(link)).toBe(true);

    const show = link.polyline!.show as Property;
    expect(show.getValue(viewer.clock.currentTime)).toBe(false);
    await flush();
    const pass = sat.props.passPredictor.passes(viewer.clock.currentTime)[0]!;
    expect(show.getValue(JulianDate.fromDate(new Date((pass.start + pass.end) / 2)))).toBe(true);
    expect(show.getValue(JulianDate.fromDate(new Date(pass.end + 60_000)))).toBe(false);
  });

  test("is removed with the satellite", async () => {
    const { sat, removed } = await setup();
    sat.show(["Point", LINK]);
    const link = sat.components[LINK];

    sat.dispose();

    expect(removed).toContain(link);
    expect(sat.eventListeners).toEqual({});
  });
});

describe("SatelliteComponentCollection lifetime", () => {
  test("draws again after every component was switched off", async () => {
    const { sat, viewer } = await setup();
    sat.show(["Point"]);
    sat.hide(["Point"]);

    sat.show(["Point"]);

    expect(sat.componentNames).toEqual(["Point"]);
    expect(sat.props.trajectory.position(viewer.clock.currentTime)).toBeDefined();
  });

  test("stops sampling once disposed", async () => {
    const { sat, viewer } = await setup();
    sat.show(["Point"]);

    sat.dispose();

    expect(sat.props.trajectory.position(viewer.clock.currentTime)).toBeUndefined();
  });
});

describe("SatelliteComponentCollection lines and ground tracks", () => {
  beforeEach(() => {
    // The ICRF transform needs async-loaded IAU data that Node lacks.
    vi.spyOn(Transforms, "computeFixedToIcrfMatrix").mockImplementation(() => Matrix3.clone(Matrix3.IDENTITY));
  });

  test("are not drawn from fewer than two distinct positions, which would stop Cesium's render loop", async () => {
    const { sat, viewer } = await setup();
    // A day past the window, where every position clamps to the last sample.
    viewer.clock.currentTime = JulianDate.addDays(viewer.clock.currentTime, 1, new JulianDate());

    sat.show(["Point", "Orbit", "Orbit track", "Ground track"]);
    expect(sat.componentNames).toEqual(["Point"]);

    viewer.clock.currentTime = JulianDate.addDays(viewer.clock.currentTime, -1, new JulianDate());
    sat.show(["Orbit", "Orbit track", "Ground track"]);
    expect(sat.componentNames).toEqual(["Point", "Orbit", "Orbit track", "Ground track"]);
  });

  test("draw the tracked satellite's orbit as a path, and go back into the batch once it is let go", async () => {
    const { sat, viewer } = await setup();
    sat.show(["Point", "Orbit", "Orbit track"]);
    expect(sat.components.Orbit).toBeInstanceOf(BatchedLine);
    expect(sat.components["Orbit track"]).toBeInstanceOf(BatchedLine);

    sat.track();
    expect(sat.components.Orbit).toBeInstanceOf(Entity);
    expect(sat.components["Orbit track"]).toBeInstanceOf(Entity);

    viewer.trackedEntity = undefined;
    expect(sat.components.Orbit).toBeInstanceOf(BatchedLine);
    expect(sat.components["Orbit track"]).toBeInstanceOf(BatchedLine);
  });

  test("recut the batched orbit on a refill once it is half a period old, not on every refill", async () => {
    const { sat, viewer, tick } = await setup();
    sat.show(["Point", "Orbit"]);
    const first = sat.components.Orbit;
    // A refill each quarter period of simulation time.
    const refill = async () => {
      viewer.clock.currentTime = JulianDate.addSeconds(viewer.clock.currentTime, sat.props.orbit.orbitalPeriod * 15 + 1, new JulianDate());
      tick();
      await flush();
    };

    await refill();
    expect(sat.components.Orbit).toBe(first);

    await refill();
    expect(sat.components.Orbit).toBeInstanceOf(BatchedLine);
    expect(sat.components.Orbit).not.toBe(first);
  });
});

describe("SatelliteComponentCollection tracking offset", () => {
  const offset = (sat: SatelliteComponentCollection, viewer: Viewer) =>
    // Cesium 1.146 types it a Cartesian3 but returns a Property; fixed in 1.147.
    // Upstream: https://github.com/CesiumGS/cesium/issues/13880
    Cartesian3.magnitude(((sat.components.Point as Entity).viewFrom as unknown as Property).getValue(viewer.clock.currentTime) as Cartesian3);

  test("stands back for context without a model", async () => {
    const { sat, viewer } = await setup();
    sat.show(["Point"]);
    expect(offset(sat, viewer)).toBeGreaterThan(5e6);
  });

  test("frames the model by its real size once it has loaded", async () => {
    const { sat, viewer, setModelRadius } = await setup();
    sat.show(["Point", "3D model"]);
    expect(offset(sat, viewer)).toBeCloseTo(15);

    setModelRadius(65);
    expect(offset(sat, viewer)).toBeCloseTo(390);
    setModelRadius(0.2);
    expect(offset(sat, viewer)).toBeCloseTo(1.2);
  });
});

describe("SatelliteComponentCollection 3D model", () => {
  test("loads the model its metadata names", async () => {
    const { sat } = await setup();
    sat.show(["Point", "3D model"]);
    expect((sat.components["3D model"] as Entity).model?.uri?.getValue(JulianDate.now())).toBe("./data/models/ISS-(ZARYA).glb");
  });

  test("is drawn no smaller than its real size allows, in css pixels", async () => {
    const { sat, viewer, setModelRadius } = await setup();
    sat.show(["Point", "3D model"]);
    const minimumPixelSize = () => (sat.components["3D model"] as Entity).model!.minimumPixelSize!.getValue(viewer.clock.currentTime);

    setModelRadius(65);
    expect(minimumPixelSize()).toBe(72);
    setModelRadius(0.15);
    expect(minimumPixelSize()).toBe(20);
  });

  test("is never bigger than at the default view, so zoomed out it shrinks with the globe", async () => {
    const { sat, viewer, setModelRadius } = await setup();
    sat.show(["Point", "3D model"]);
    const largestDiameter = (radius: number) => {
      setModelRadius(radius);
      return (sat.components["3D model"] as Entity).model!.maximumScale!.getValue(viewer.clock.currentTime) * 2 * radius;
    };
    const earth = 2 * 6378137;

    // About a tenth of the Earth for the ISS, and a cubesat at its 20 of the ISS's 72 px.
    expect(largestDiameter(65) / earth).toBeCloseTo(0.103, 3);
    expect(largestDiameter(0.15) / largestDiameter(65)).toBeCloseTo(20 / 72);
  });

  test("is not drawn, and nothing is fetched, for a satellite without a model", async () => {
    const { sat, viewer } = await setup({ modelFile: null });
    sat.show(["Point", "3D model"]);
    expect(sat.componentNames).toEqual(["Point"]);
    // Tracking does not wait for a model that will never load.
    sat.track();
    expect(viewer.trackedEntity).toBe(sat.components.Point);
  });
});

describe("SatelliteComponentCollection 3D model with a lower-detail copy", () => {
  const ISS_LOW = [{ file: "ISS-(ZARYA)-low.glb", maxPoints: 100 }];

  async function withCopy() {
    const setUp = await setup({ lods: ISS_LOW });
    setUp.sat.show(["Point", "3D model"]);
    const model = setUp.sat.components["3D model"] as Entity;
    const copy = [...setUp.entities].find((entity) => entity !== model && (entity as Entity).model) as Entity;
    const shown = (entity: Entity) => entity.model!.show!.getValue(setUp.viewer.clock.currentTime) as boolean;
    const { loading, failed } = setUp.viewer as unknown as { loading: Set<Entity>; failed: Set<Entity> };
    return { ...setUp, model, copy, shown, loading, failed };
  }

  test("adds the copy beside the model, and removes it with the model", async () => {
    const { sat, model, copy, removed } = await withCopy();
    expect(copy.model?.uri?.getValue(JulianDate.now())).toBe("./data/models/ISS-(ZARYA)-low.glb");
    sat.hide(["3D model"]);
    expect(removed).toEqual(expect.arrayContaining([model, copy]));
  });

  test("draws the copy while the model is small, and does not load the file", async () => {
    const { model, copy, shown, setModelRadius } = await withCopy();
    setModelRadius(65);
    // At the default view's 1 km a pixel, the ISS is drawn at its 72 px minimum.
    expect(shown(copy)).toBe(true);
    expect(shown(model)).toBe(false);
  });

  test("loads the file once the model is large, and keeps the copy until it has", async () => {
    const { model, copy, shown, loading, setModelRadius, setMetresPerPixel } = await withCopy();
    setModelRadius(65);
    shown(copy);
    setMetresPerPixel(0.5);
    loading.add(model);
    expect(shown(model)).toBe(true);
    expect(shown(copy)).toBe(true);
    loading.delete(model);
    expect(shown(model)).toBe(true);
    expect(shown(copy)).toBe(false);
  });

  test("goes back to the copy only once the model is well below its maxPoints", async () => {
    const { model, copy, shown, setModelRadius, setMetresPerPixel } = await withCopy();
    setModelRadius(65);
    setMetresPerPixel(0.5);
    shown(model);
    // 130 m across: 1.4 m a pixel is 93 px, inside the copy's 100 but above 80.
    setMetresPerPixel(1.4);
    expect(shown(model)).toBe(true);
    setMetresPerPixel(2);
    expect(shown(copy)).toBe(true);
    expect(shown(model)).toBe(false);
  });

  test("draws the file of a tracked satellite, however small", async () => {
    const { sat, viewer, model, shown, setModelRadius } = await withCopy();
    setModelRadius(65);
    viewer.trackedEntity = model;
    expect(sat.isTracked).toBe(true);
    expect(shown(model)).toBe(true);
  });

  test("selects and tracks the model when a pick lands on its copy", async () => {
    const { sat, viewer, model, copy } = await withCopy();
    viewer.selectedEntity = copy;
    expect(viewer.selectedEntity).toBe(model);
    expect(sat.isSelected).toBe(true);
    viewer.trackedEntity = copy;
    expect(viewer.trackedEntity).toBe(model);
  });

  test("asks for the file once tracked, though Cesium calls a model it never created failed", async () => {
    const { viewer, model, copy, shown, failed, setModelRadius } = await withCopy();
    setModelRadius(65);
    failed.add(model);
    expect(shown(model)).toBe(false);
    viewer.trackedEntity = model;
    // Cesium evaluates the copy's callback first as often as not, before it creates the file's model.
    shown(copy);
    expect(shown(model)).toBe(true);
  });

  test("keeps rendering while the file loads behind a copy, as Cesium loads only on rendered frames", async () => {
    const { sat, model, copy, shown, loading, setModelRadius, setMetresPerPixel } = await withCopy();
    setModelRadius(65);
    shown(copy);
    expect(sat.model.pending).toBe(false);
    setMetresPerPixel(0.5);
    loading.add(model);
    shown(model);
    expect(sat.model.pending).toBe(true);
    loading.delete(model);
    shown(model);
    expect(sat.model.pending).toBe(false);
  });

  test("draws the file when the copy cannot load", async () => {
    const { model, copy, shown, failed, setModelRadius } = await withCopy();
    setModelRadius(65);
    shown(copy);
    failed.add(copy);
    expect(shown(model)).toBe(true);
    expect(shown(copy)).toBe(false);
  });

  test("comes back from the copy when shown again, whatever it was drawn at before", async () => {
    const { sat, viewer, shown, setModelRadius, setMetresPerPixel } = await withCopy();
    setModelRadius(65);
    setMetresPerPixel(0.5);
    shown(sat.components["3D model"] as Entity);
    sat.hide(["3D model"]);
    sat.show(["3D model"]);
    setMetresPerPixel(1000);
    const model = sat.components["3D model"] as Entity;
    (viewer as unknown as { loading: Set<Entity> }).loading.add(model);
    expect(shown(model)).toBe(false);
  });

  test("measures the copy it draws, so the label and point follow it", async () => {
    const { sat, model, loading, setModelRadius } = await withCopy();
    loading.add(model);
    setModelRadius(65);
    expect(sat.model.state()).toBe("ready");
    expect(sat.model.radius()).toBe(65);
  });
});

describe("modelMinimumPixelSize", () => {
  test("orders models by size between a cubesat's floor and the ISS's ceiling", () => {
    expect(modelMinimumPixelSize(0.3)).toBe(20);
    expect(modelMinimumPixelSize(3.8)).toBeCloseTo(36, 0);
    expect(modelMinimumPixelSize(13.4)).toBeCloseTo(55, 0);
    expect(modelMinimumPixelSize(131)).toBe(72);
  });

  test("keeps Landsat well above a cubesat, whatever its sphere leaves empty", () => {
    expect(modelMinimumPixelSize(13.4) / modelMinimumPixelSize(0.64)).toBeGreaterThan(2.5);
  });
});

describe("SatelliteComponentCollection beside its model", () => {
  const ALL = ["Point", "Label", "3D model"];
  const labelOffset = (sat: SatelliteComponentCollection, viewer: Viewer) =>
    ((sat.components.Label as Entity).label!.pixelOffset!.getValue(viewer.clock.currentTime) as Cartesian2).x;
  const pointShown = (sat: SatelliteComponentCollection, viewer: Viewer) => (sat.components.Point as Entity).point!.show?.getValue(viewer.clock.currentTime) ?? true;

  test("starts the label past the model's edge, and hides the point the model stands in for", async () => {
    const { sat, viewer, setModelRadius } = await setup();
    sat.show(ALL);
    setModelRadius(65);

    // The ISS at its 72 px minimum.
    expect(labelOffset(sat, viewer)).toBeCloseTo(40);
    expect(pointShown(sat, viewer)).toBe(false);
  });

  test("follows the model's real size up close", async () => {
    const { sat, viewer, setModelRadius, setMetresPerPixel } = await setup();
    sat.show(ALL);
    setModelRadius(65);
    setMetresPerPixel(0.5);

    expect(labelOffset(sat, viewer)).toBeCloseTo(130 / 0.5 / 2 + 4);
  });

  test("gives the point back once zooming out has shrunk the model", async () => {
    const { sat, viewer, setModelRadius, setMetresPerPixel } = await setup();
    sat.show(ALL);
    setModelRadius(65);
    // Five times the default view's distance: the ISS is a fifth of its 72 px, still a marker.
    setMetresPerPixel(5 * 18_270);
    expect(pointShown(sat, viewer)).toBe(false);
    expect(labelOffset(sat, viewer)).toBeCloseTo(72 / 5 / 2 + 4, 1);

    // Ten times: 7 px.
    setMetresPerPixel(10 * 18_270);
    expect(pointShown(sat, viewer)).toBe(true);
  });

  test("keeps the point and the usual offset while the model is off or loading", async () => {
    const { sat, viewer } = await setup();
    sat.show(["Point", "Label"]);
    expect(labelOffset(sat, viewer)).toBe(10);
    expect(pointShown(sat, viewer)).toBe(true);

    sat.show(ALL);
    expect(labelOffset(sat, viewer)).toBe(10);
    expect(pointShown(sat, viewer)).toBe(true);
  });

  test("asks the model only while it is shown, in either order", async () => {
    const { sat, viewer, setModelRadius } = await setup();
    setModelRadius(65);
    const show = () => (sat.components.Point as Entity).point!.show;
    sat.show(["Point"]);
    // A show callback is evaluated for every point on every tick.
    expect(show()).toBeUndefined();

    sat.show(["3D model"]);
    expect(pointShown(sat, viewer)).toBe(false);
    sat.hide(["3D model"]);
    expect(show()).toBeUndefined();

    sat.hide(["Point"]);
    sat.show(["3D model", "Point"]);
    expect(pointShown(sat, viewer)).toBe(false);
  });
});

describe("SatelliteComponentCollection tracking a model", () => {
  test("waits for the model to load, so the camera does not start inside it", async () => {
    const { sat, viewer, setModelRadius } = await setup();
    sat.show(["Point", "3D model"]);
    const render = (viewer as unknown as { render: () => void }).render;

    sat.track();
    render();
    expect(viewer.trackedEntity).toBeUndefined();

    setModelRadius(65);
    render();
    expect(viewer.trackedEntity).toBe(sat.components.Point);
  });

  test("counts a model the display has not seen yet as loading", async () => {
    const { sat, viewer } = await setup();
    sat.show(["Point", "3D model"]);
    (viewer.dataSourceDisplay as unknown as { getBoundingSphere: () => never }).getBoundingSphere = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'updaters')");
    };

    expect(() => sat.track()).not.toThrow();
    expect(viewer.trackedEntity).toBeUndefined();
  });

  test("tracks at once without a model", async () => {
    const { sat, viewer } = await setup();
    sat.show(["Point"]);
    sat.track();
    expect(viewer.trackedEntity).toBe(sat.components.Point);
  });
});

describe("SatelliteComponentCollection sky appearance", () => {
  const alpha = (property: Property | undefined, time: JulianDate) => (property!.getValue(time) as { alpha: number }).alpha;

  test("dims the point and the label, and restores them", async () => {
    const { sat, viewer } = await setup({ modelFile: null });
    sat.show(["Point", "Label"]);
    const point = sat.components.Point as Entity;
    const label = sat.components.Label as Entity;
    const time = viewer.clock.currentTime;

    sat.skyAppearance = "dimmedDark";
    expect(alpha(point.point!.color, time)).toBeLessThan(1);
    expect(alpha(label.label!.fillColor, time)).toBeLessThan(1);
    expect(point.show).toBe(true);

    sat.skyAppearance = "normal";
    expect(alpha(point.point!.color, time)).toBe(1);
    expect(alpha(label.label!.fillColor, time)).toBe(1);
  });

  test("dims less in daylight than on a dark sky", async () => {
    const { sat, viewer } = await setup({ modelFile: null });
    sat.show(["Point"]);
    const point = sat.components.Point as Entity;
    const time = viewer.clock.currentTime;

    sat.skyAppearance = "dimmedDaylight";
    const daylight = alpha(point.point!.color, time);
    sat.skyAppearance = "dimmedDark";
    const dark = alpha(point.point!.color, time);

    expect(daylight).toBeLessThan(1);
    expect(dark).toBeLessThan(daylight);
  });

  test("hides the point, the label and the model, and shows them again", async () => {
    const { sat } = await setup();
    sat.show(["Point", "Label", "3D model"]);
    const entities = ["Point", "Label", "3D model"].map((name) => sat.components[name] as Entity);

    sat.skyAppearance = "hidden";
    expect(entities.map((entity) => entity.show)).toEqual([false, false, false]);

    sat.skyAppearance = "normal";
    expect(entities.map((entity) => entity.show)).toEqual([true, true, true]);
  });

  test("applies to a component created while it holds", async () => {
    const { sat } = await setup({ modelFile: null });
    sat.show(["Point"]);
    sat.skyAppearance = "hidden";

    sat.show(["Label"]);

    expect((sat.components.Label as Entity).show).toBe(false);
  });
});
