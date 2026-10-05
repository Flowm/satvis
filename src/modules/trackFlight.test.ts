import { Cartesian3, Entity } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { describe, expect, test } from "vitest";

import { cancelPendingTrack, returnAfterTracking, trackEntity, trackWhenReady, type CameraPose } from "./trackFlight";

const POSE: CameraPose = { destination: new Cartesian3(1, 0, 0), direction: Cartesian3.UNIT_X, up: Cartesian3.UNIT_Z };

/**
 * A viewer whose camera flights finish when told to, and are cancelled the way Cesium cancels them.
 */
function fakeViewer() {
  type Flight = { destination: Cartesian3; complete?: () => void; cancel?: () => void };
  let flight: Flight | undefined;
  let tracked: Entity | undefined;
  let at = new Cartesian3(9, 9, 9);
  const listeners = new Set<() => void>();
  const postRender = new Set<() => void>();
  const viewer = {
    clock: { shouldAnimate: true },
    scene: {
      postRender: {
        addEventListener(listener: () => void) {
          postRender.add(listener);
          return () => postRender.delete(listener);
        },
      },
    },
    camera: {
      get positionWC() {
        return at;
      },
      directionWC: Cartesian3.UNIT_X,
      upWC: Cartesian3.UNIT_Z,
      flyTo(options: Flight) {
        this.cancelFlight();
        flight = options;
      },
      cancelFlight() {
        const current = flight;
        flight = undefined;
        current?.cancel?.();
      },
    },
    get trackedEntity() {
      return tracked;
    },
    set trackedEntity(entity: Entity | undefined) {
      if (entity !== tracked) {
        tracked = entity;
        listeners.forEach((listener) => listener());
      }
    },
    trackedEntityChanged: {
      addEventListener(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const land = () => {
    const current = flight;
    flight = undefined;
    if (current) {
      at = current.destination;
      current.complete?.();
    }
  };
  const moveTo = (position: Cartesian3) => {
    at = position;
  };
  const render = () => [...postRender].forEach((listener) => listener());
  return { viewer: viewer as unknown as Viewer, land, moveTo, render, flying: () => flight !== undefined, destination: () => flight?.destination };
}

describe("trackEntity", () => {
  test("holds the clock for the flight and tracks on arrival", () => {
    const { viewer, land } = fakeViewer();
    const a = new Entity();

    trackEntity(viewer, () => a, POSE);
    expect(viewer.trackedEntity).toBeUndefined();
    expect(viewer.clock.shouldAnimate).toBe(false);

    land();
    expect(viewer.trackedEntity).toBe(a);
    expect(viewer.clock.shouldAnimate).toBe(true);
  });

  test("a second track supersedes the first, and the clock comes back as the first found it", () => {
    const { viewer, land } = fakeViewer();
    const a = new Entity();
    const b = new Entity();

    trackEntity(viewer, () => a, POSE);
    trackEntity(viewer, () => b, POSE);
    expect(viewer.clock.shouldAnimate).toBe(false);

    land();
    expect(viewer.trackedEntity).toBe(b);
    expect(viewer.clock.shouldAnimate).toBe(true);
  });

  test("an instant track mid-flight wins and gives the clock back", () => {
    const { viewer, flying } = fakeViewer();
    const a = new Entity();
    const b = new Entity();

    trackEntity(viewer, () => a, POSE);
    trackEntity(viewer, () => b);

    expect(flying()).toBe(false);
    expect(viewer.trackedEntity).toBe(b);
    expect(viewer.clock.shouldAnimate).toBe(true);
  });

  test("anything else taking trackedEntity mid-flight cancels it", () => {
    const { viewer, flying } = fakeViewer();
    const a = new Entity();
    const station = new Entity();

    trackEntity(viewer, () => a, POSE);
    viewer.trackedEntity = station;

    expect(flying()).toBe(false);
    expect(viewer.trackedEntity).toBe(station);
    expect(viewer.clock.shouldAnimate).toBe(true);
  });

  test("a cancelled flight gives the clock back without tracking", () => {
    const { viewer } = fakeViewer();
    viewer.clock.shouldAnimate = false;

    trackEntity(viewer, () => new Entity(), POSE);
    viewer.camera.cancelFlight();

    expect(viewer.trackedEntity).toBeUndefined();
    expect(viewer.clock.shouldAnimate).toBe(false);
  });

  test("lands on nothing when the satellite went away mid-flight", () => {
    const { viewer, land } = fakeViewer();
    let entity: Entity | undefined = new Entity();

    trackEntity(viewer, () => entity, POSE);
    entity = undefined;
    land();

    expect(viewer.trackedEntity).toBeUndefined();
  });
});

describe("returnAfterTracking", () => {
  const before = new Cartesian3(1, 2, 3);

  function setup() {
    const fake = fakeViewer();
    fake.moveTo(before);
    returnAfterTracking(fake.viewer);
    return fake;
  }

  test("flies back to the view tracking began from", () => {
    const { viewer, moveTo, destination } = setup();

    trackEntity(viewer, () => new Entity());
    moveTo(new Cartesian3(7, 7, 7));
    viewer.trackedEntity = undefined;

    expect(destination()).toEqual(before);
  });

  test("returns to the view before the first of several tracks, and not between them", () => {
    const { viewer, land, destination, flying } = setup();

    trackEntity(viewer, () => new Entity(), POSE);
    land();
    trackEntity(viewer, () => new Entity(), { ...POSE, destination: new Cartesian3(5, 0, 0) });
    expect(destination()).toEqual(new Cartesian3(5, 0, 0));
    land();
    expect(flying()).toBe(false);

    viewer.trackedEntity = undefined;
    expect(destination()).toEqual(before);
  });

  test("forgets the view when a flight is cancelled with nothing tracked", () => {
    const { viewer, moveTo, destination } = setup();

    trackEntity(viewer, () => new Entity(), POSE);
    viewer.camera.cancelFlight();
    // Whatever cancelled it took the camera elsewhere.
    const elsewhere = new Cartesian3(4, 4, 4);
    moveTo(elsewhere);
    trackEntity(viewer, () => new Entity());
    viewer.trackedEntity = undefined;

    expect(destination()).toEqual(elsewhere);
  });
});

describe("trackWhenReady", () => {
  test("tracks once ready, after a render", () => {
    const { viewer, render } = fakeViewer();
    const a = new Entity();
    let ready = false;
    trackWhenReady(
      viewer,
      "a",
      () => ready,
      () => (viewer.trackedEntity = a),
    );
    render();
    expect(viewer.trackedEntity).toBeUndefined();
    ready = true;
    render();
    expect(viewer.trackedEntity).toBe(a);
  });

  test("lets the latest request win when both are waiting", () => {
    const { viewer, render } = fakeViewer();
    const a = new Entity();
    const b = new Entity();
    const ready = { a: false, b: false };
    trackWhenReady(
      viewer,
      "a",
      () => ready.a,
      () => (viewer.trackedEntity = a),
    );
    trackWhenReady(
      viewer,
      "b",
      () => ready.b,
      () => (viewer.trackedEntity = b),
    );

    ready.b = true;
    render();
    expect(viewer.trackedEntity).toBe(b);
    ready.a = true;
    render();
    expect(viewer.trackedEntity).toBe(b);
  });

  test("is dropped when tracking changes some other way", () => {
    const { viewer, render } = fakeViewer();
    const a = new Entity();
    const other = new Entity();
    let ready = false;
    trackWhenReady(
      viewer,
      "a",
      () => ready,
      () => (viewer.trackedEntity = a),
    );
    viewer.trackedEntity = other;
    ready = true;
    render();
    expect(viewer.trackedEntity).toBe(other);
  });

  test("is dropped only by its owner", () => {
    const { viewer, render } = fakeViewer();
    const a = new Entity();
    let ready = false;
    trackWhenReady(
      viewer,
      "a",
      () => ready,
      () => (viewer.trackedEntity = a),
    );
    cancelPendingTrack(viewer, "b");
    ready = true;
    render();
    expect(viewer.trackedEntity).toBe(a);
  });
});
