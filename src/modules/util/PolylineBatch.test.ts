// The slots and the packing are covered here; drawing them needs a real WebGL context,
// which the e2e specs that show orbits have.

import { Cartesian3, Color, JulianDate } from "@cesium/core";
import { SceneMode } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { describe, expect, test } from "vitest";

import { BatchedLine, LineSlots, POINTS_PER_SLOT, PolylineBatch, slotRuns } from "./PolylineBatch";

const FLOATS_PER_SLOT = POINTS_PER_SLOT * 4;

function line(count = 3): BatchedLine {
  return new BatchedLine(Array.from({ length: count }, (_, i) => new Cartesian3(7e6 + i, i, 0 - i || 0)));
}

function fakeViewer() {
  const primitives = {
    added: [] as unknown[],
    add(primitive: unknown) {
      this.added.push(primitive);
    },
  };
  let renders = 0;
  const viewer = {
    clock: { currentTime: JulianDate.fromIso8601("2026-01-01T00:00:00Z") },
    scene: {
      mode: SceneMode.SCENE3D,
      primitives,
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
  };
}

describe("BatchedLine", () => {
  test("packs its points as float32 x, y, z and knows the farthest", () => {
    const packed = line(2);

    expect([...packed.points]).toEqual([7e6, 0, 0, 7e6 + 1, 1, -1]);
    expect(packed.radius).toBeCloseTo(Math.hypot(7e6 + 1, 1, 1));
  });

  test("keeps the slot's last point free for the break", () => {
    expect(line(POINTS_PER_SLOT + 5).points).toHaveLength((POINTS_PER_SLOT - 1) * 3);
  });
});

describe("LineSlots", () => {
  test("gives each line its own slot, and the draw ends at the last", () => {
    const slots = new LineSlots();
    slots.add(line());
    slots.add(line());

    expect(slots.extent).toBe(2);
    expect(slots.takeDirty()).toEqual([0, 1]);
    expect(slots.dirty).toBe(false);
  });

  test("a recreate, a remove and an add, keeps its slot and uploads only that one", () => {
    const slots = new LineSlots();
    const lines = [line(), line(), line()];
    lines.forEach((member) => slots.add(member));
    slots.takeDirty();

    slots.remove(lines[1]!);
    slots.add(line());

    expect(slots.extent).toBe(3);
    expect(slots.takeDirty()).toEqual([1]);
  });

  test("replace swaps a member in its slot, and refuses a stranger", () => {
    const slots = new LineSlots();
    const first = line();
    slots.add(first);
    slots.takeDirty();
    const second = line();

    expect(slots.replace(first, second)).toBe(true);
    expect(slots.takeDirty()).toEqual([0]);
    expect(slots.replace(first, line())).toBe(false);
    expect(slots.remove(second)).toBe(true);
  });

  test("removing the last lines shortens the draw", () => {
    const slots = new LineSlots();
    const lines = [line(), line(), line()];
    lines.forEach((member) => slots.add(member));

    slots.remove(lines[2]!);
    slots.remove(lines[1]!);

    expect(slots.extent).toBe(1);
    // A freed slot past the end is not handed out again.
    slots.add(line());
    expect(slots.extent).toBe(2);
  });

  test("writes a line's points with w = 1, then breaks, so no segment joins two slots", () => {
    const slots = new LineSlots();
    slots.add(line(2));
    slots.add(line(2));

    const packed = slots.writeAll(3);

    expect([...packed.subarray(0, 8)]).toEqual([7e6, 0, 0, 1, 7e6 + 1, 1, -1, 1]);
    expect(packed[FLOATS_PER_SLOT - 1]).toBe(0);
    expect(packed[FLOATS_PER_SLOT + 3]).toBe(1);
    // The spare slot draws nothing.
    expect(packed.subarray(2 * FLOATS_PER_SLOT).every((value) => value === 0)).toBe(true);
  });

  test("an emptied slot is written as breaks", () => {
    const slots = new LineSlots();
    const member = line();
    slots.add(member);
    slots.add(line());
    slots.remove(member);

    const out = new Float32Array(FLOATS_PER_SLOT).fill(9);
    slots.write(0, out);

    expect(out.every((value) => value === 0)).toBe(true);
  });
});

describe("slotRuns", () => {
  test("a build's appended slots are one upload, scattered refills one each", () => {
    expect(slotRuns([10, 11, 12, 13])).toEqual([[10, 13]]);
    expect(slotRuns([2, 500, 9000])).toEqual([
      [2, 2],
      [500, 500],
      [9000, 9000],
    ]);
  });

  test("near neighbours share an upload, the slots between them included", () => {
    expect(slotRuns([3, 7, 11, 40])).toEqual([
      [3, 11],
      [40, 40],
    ]);
  });
});

describe("PolylineBatch", () => {
  test("is a primitive in the scene from the start", () => {
    const host = fakeViewer();
    const batch = new PolylineBatch(host.viewer, "inertial", Color.WHITE);

    expect(host.primitives.added).toEqual([batch]);
  });

  test("a change asks for the frame that uploads it", () => {
    const host = fakeViewer();
    const batch = new PolylineBatch(host.viewer, "fixed", Color.GOLD);

    batch.add(line());

    expect(host.renders).toBe(1);
  });

  test("replace refuses a line that is no longer a member", () => {
    const host = fakeViewer();
    const batch = new PolylineBatch(host.viewer, "fixed", Color.GOLD);

    // The satellite disabled its track between the refresh being scheduled and running.
    expect(batch.replace(line(), line())).toBe(false);
    expect(host.renders).toBe(0);
  });
});
