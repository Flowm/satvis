import { type BoundingSphere, Cartesian3, Entity, JulianDate, Math as CesiumMath, PerspectiveFrustum, type Property } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { describe, expect, test } from "vitest";

import type { GroundStation } from "./PassPredictor";
import { CatalogEntry } from "./SatelliteCatalog";
import { SatelliteComponentCollection, modelMinimumPixelSize } from "./SatelliteComponentCollection";
import { parseGpPayload, type GpRecord } from "./util/gp";
import { InlinePassSource } from "./util/passSource";
import { PolylineBatch } from "./util/PolylineBatch";
import { InlineSampleSource } from "./util/sampleSource";

const LINK = "Ground station link";

const TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

const munich = (): GroundStation => ({ name: "Munich", position: { latitude: 48.14, longitude: 11.58, height: 0 } });

/** A viewer whose entities collection records what is added and removed. */
function fakeViewer() {
  const entities = new Set<unknown>();
  const postRender = new Set<() => void>();
  const removed: unknown[] = [];
  const viewer = {
    clock: {
      currentTime: JulianDate.fromIso8601("2018-12-08T00:00:00Z"),
      shouldAnimate: false,
      onTick: { addEventListener: () => () => {} },
    },
    scene: {
      requestRender: () => {},
      primitives: { add: () => {}, remove: () => true },
      mode: 3,
      // A desktop window: Cesium's 60° is then the horizontal angle.
      camera: { frustum: new PerspectiveFrustum({ fov: CesiumMath.toRadians(60), aspectRatio: 1400 / 900 }) },
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
    selectedEntity: undefined,
    trackedEntity: undefined,
    selectedEntityChanged: { addEventListener: () => () => {} },
    trackedEntityChanged: { addEventListener: () => () => {} },
    // A model measures `modelRadius` once loaded; until then Cesium reports PENDING (1).
    modelRadius: undefined as number | undefined,
    dataSourceDisplay: {
      getBoundingSphere(_entity: Entity, _partial: boolean, result: BoundingSphere): number {
        if (viewer.modelRadius === undefined) {
          return 1;
        }
        result.radius = viewer.modelRadius;
        return 0;
      },
    },
  };
  return { viewer: viewer as unknown as Viewer, entities, removed };
}

/** The ISS, with the model its manifest entry gives it unless `modelFile` is null. */
async function setup({ modelFile = "ISS-(ZARYA).glb" }: { modelFile?: string | null } = {}) {
  const { viewer, entities, removed } = fakeViewer();
  const record = parseGpPayload(TLE)[0] as GpRecord;
  if (modelFile !== null) {
    record.metadata = { modelFile };
  }
  const entry = new CatalogEntry({ key: "25544|ISS", name: "ISS", nameUpper: "ISS", satnum: "25544", tags: [], record });
  const sampler = new InlineSampleSource().samplerFor(entry.satnum, entry.record);
  const predictor = new InlinePassSource().predictorFor(entry.satnum, entry.record);
  const batches = { orbits: new PolylineBatch(viewer, "inertial"), tracks: new PolylineBatch(viewer, "fixed") };
  const sat = new SatelliteComponentCollection(viewer, entry, batches, sampler, predictor);
  const nowMs = JulianDate.toDate(viewer.clock.currentTime).getTime();
  const chunk = await sampler.samples(nowMs - 3600_000, nowMs + 3600_000);
  if (chunk) sat.props.trajectory.adopt(chunk);
  return { sat, viewer, entities, removed, setModelRadius: (radius: number) => ((viewer as unknown as { modelRadius?: number }).modelRadius = radius) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

describe("SatelliteComponentCollection tracking offset", () => {
  const offset = (sat: SatelliteComponentCollection, viewer: Viewer) =>
    Cartesian3.magnitude((sat.components.Point as Entity).viewFrom!.getValue(viewer.clock.currentTime) as Cartesian3);

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
