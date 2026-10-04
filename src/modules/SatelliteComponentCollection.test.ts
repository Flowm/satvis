import { type BoundingSphere, Cartesian3, Entity, JulianDate, type Property } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { describe, expect, test } from "vitest";

import type { GroundStation } from "./PassPredictor";
import { CatalogEntry } from "./SatelliteCatalog";
import { SatelliteComponentCollection } from "./SatelliteComponentCollection";
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

async function setup() {
  const { viewer, entities, removed } = fakeViewer();
  const record = parseGpPayload(TLE)[0] as GpRecord;
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
