// The viewer is faked with a hand-cranked clock. The build itself is not covered:
// driving a Primitive through its creation states needs a real WebGL context.

import { ArcType, Cartesian3, Color, ColorGeometryInstanceAttribute, GeometryInstance, JulianDate, PolylineColorAppearance, PolylineGeometry, SceneMode } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { describe, expect, test } from "vitest";

import { PolylineBatch } from "./PolylineBatch";

function orbitGeometry(id: string): GeometryInstance {
  return new GeometryInstance({
    geometry: new PolylineGeometry({
      positions: Cartesian3.fromDegreesArray([0, 0, 10, 10]),
      width: 2,
      arcType: ArcType.NONE,
      vertexFormat: PolylineColorAppearance.VERTEX_FORMAT,
    }),
    attributes: { color: ColorGeometryInstanceAttribute.fromColor(new Color(1, 1, 1, 0.15)) },
    id,
  });
}

function fakeViewer() {
  const listeners = new Set<() => void>();
  const primitives = {
    added: [] as unknown[],
    removed: [] as unknown[],
    add(primitive: unknown) {
      this.added.push(primitive);
    },
    remove(primitive: unknown) {
      this.removed.push(primitive);
      return true;
    },
  };
  let renders = 0;

  const viewer = {
    clock: {
      currentTime: JulianDate.fromIso8601("2026-01-01T00:00:00Z"),
      onTick: {
        addEventListener(listener: () => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    scene: {
      mode: SceneMode.SCENE3D,
      primitives,
      frameState: {},
      requestRender() {
        renders += 1;
      },
    },
  };

  return {
    viewer: viewer as unknown as Viewer,
    primitives,
    get renders() {
      return renders;
    },
    get listenerCount() {
      return listeners.size;
    },
    tick(times = 1) {
      for (let i = 0; i < times; i += 1) {
        [...listeners].forEach((listener) => listener());
      }
    },
  };
}

/** Mirrors PolylineBatch's own window; the callback fires on the tick after it. */
const COALESCE_TICKS = 30;
const PAST_WINDOW = COALESCE_TICKS + 2;

describe("PolylineBatch", () => {
  test("nothing added, nothing pending, settled resolves at once", async () => {
    const { viewer } = fakeViewer();
    const batch = new PolylineBatch(viewer);

    expect(batch.pending).toBe(false);
    await expect(batch.settled()).resolves.toBeUndefined();
  });

  test("an add is pending, and nothing reaches the scene before the window closes", () => {
    const host = fakeViewer();
    const batch = new PolylineBatch(host.viewer);

    batch.add(orbitGeometry("ISS"));

    expect(batch.pending).toBe(true);
    host.tick(COALESCE_TICKS - 1);
    expect(host.primitives.added).toHaveLength(0);
    expect(batch.pending).toBe(true);
  });

  test("many adds in one window cost one rebuild", () => {
    const host = fakeViewer();
    const batch = new PolylineBatch(host.viewer);
    const before = host.listenerCount;

    for (let i = 0; i < 50; i += 1) {
      batch.add(orbitGeometry(`SAT-${i}`));
    }

    expect(host.listenerCount).toBe(before + 1);
  });

  test("removing the last geometry clears the batch and settles", async () => {
    const host = fakeViewer();
    const batch = new PolylineBatch(host.viewer);
    const geometry = orbitGeometry("ISS");

    batch.add(geometry);
    batch.remove(geometry);
    expect(batch.pending).toBe(true);

    const settled = batch.settled();
    host.tick(PAST_WINDOW);
    await expect(settled).resolves.toBeUndefined();
    expect(batch.pending).toBe(false);
  });

  test("the empty rebuild stops its own tick callback", () => {
    const host = fakeViewer();
    const batch = new PolylineBatch(host.viewer);
    // The constructor's permanent inertial-frame updater.
    const permanent = host.listenerCount;

    const geometry = orbitGeometry("ISS");
    batch.add(geometry);
    batch.remove(geometry);
    host.tick(PAST_WINDOW);

    expect(host.listenerCount).toBe(permanent);
  });

  test("settled() called when idle does not wait for a tick", async () => {
    const host = fakeViewer();
    const batch = new PolylineBatch(host.viewer);
    const geometry = orbitGeometry("ISS");

    batch.add(geometry);
    batch.remove(geometry);
    host.tick(PAST_WINDOW);
    await batch.settled();

    await expect(batch.settled()).resolves.toBeUndefined();
  });

  test("replace swaps a member's geometry in place and schedules one rebuild", () => {
    const host = fakeViewer();
    const batch = new PolylineBatch(host.viewer, "fixed");
    const first = orbitGeometry("ISS");
    const second = orbitGeometry("ISS");

    batch.add(first);
    expect(batch.replace(first, second)).toBe(true);
    expect(batch.size).toBe(1);
    expect(batch.pending).toBe(true);
  });

  test("replace refuses a geometry that is no longer a member", () => {
    const host = fakeViewer();
    const batch = new PolylineBatch(host.viewer, "fixed");
    const stale = orbitGeometry("ISS");

    // The satellite disabled its track between the refresh being scheduled and running.
    expect(batch.replace(stale, orbitGeometry("ISS"))).toBe(false);
    expect(batch.size).toBe(0);
  });

  test("only the inertial batch installs a periodic re-orientation", () => {
    const host = fakeViewer();
    const before = host.listenerCount;

    const inertial = new PolylineBatch(host.viewer, "inertial");
    expect(inertial.size).toBe(0);
    expect(host.listenerCount).toBe(before + 1);

    const fixed = new PolylineBatch(host.viewer, "fixed");
    expect(fixed.size).toBe(0);
    expect(host.listenerCount).toBe(before + 1);
  });
});
