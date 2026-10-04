import { Cartesian3, Entity } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { describe, expect, test } from "vitest";

import { trackEntity, trackFlightPending, type CameraPose } from "./trackFlight";

const POSE: CameraPose = { destination: new Cartesian3(1, 0, 0), direction: Cartesian3.UNIT_X, up: Cartesian3.UNIT_Z };

/** A viewer whose camera flights finish when told to, and are cancelled the way Cesium cancels them. */
function fakeViewer() {
  type Flight = { complete: () => void; cancel: () => void };
  let flight: Flight | undefined;
  let tracked: Entity | undefined;
  const listeners = new Set<() => void>();
  const viewer = {
    clock: { shouldAnimate: true },
    camera: {
      flyTo(options: Flight) {
        this.cancelFlight();
        flight = options;
      },
      cancelFlight() {
        const current = flight;
        flight = undefined;
        current?.cancel();
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
    current?.complete();
  };
  return { viewer: viewer as unknown as Viewer, land, flying: () => flight !== undefined };
}

describe("trackEntity", () => {
  test("holds the clock for the flight and tracks on arrival", () => {
    const { viewer, land } = fakeViewer();
    const a = new Entity();

    trackEntity(viewer, () => a, POSE);
    expect(viewer.trackedEntity).toBeUndefined();
    expect(viewer.clock.shouldAnimate).toBe(false);
    expect(trackFlightPending(viewer)).toBe(true);

    land();
    expect(viewer.trackedEntity).toBe(a);
    expect(viewer.clock.shouldAnimate).toBe(true);
    expect(trackFlightPending(viewer)).toBe(false);
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
    expect(trackFlightPending(viewer)).toBe(false);
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
