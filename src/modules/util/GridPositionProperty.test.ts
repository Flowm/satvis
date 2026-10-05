import { Cartesian3, Entity, JulianDate, ReferenceFrame, VelocityOrientationProperty } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { GridPositionProperty } from "./GridPositionProperty";

const ANCHOR_MS = Date.UTC(2018, 11, 8);
const STEP = 45;

const anchor = () => JulianDate.fromDate(new Date(ANCHOR_MS));
const at = (seconds: number) => JulianDate.addSeconds(anchor(), seconds, new JulianDate());

/** A straight line through the grid, so an exact answer is known at every instant. */
const ramp = (fromIndex: number, count: number): Float64Array => {
  const xyz = new Float64Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const gridIndex = fromIndex + index;
    xyz[index * 3] = gridIndex * 100;
    xyz[index * 3 + 1] = gridIndex * -200;
    xyz[index * 3 + 2] = 7000;
  }
  return xyz;
};

const filled = (fromIndex = 0, count = 10): GridPositionProperty => {
  const property = new GridPositionProperty();
  property.reset(ANCHOR_MS, STEP);
  property.add(fromIndex, ramp(fromIndex, count));
  return property;
};

describe("GridPositionProperty", () => {
  test("is constant, and reads as nothing, until it holds samples", () => {
    const property = new GridPositionProperty();
    expect(property.isConstant).toBe(true);
    expect(property.getValue(at(0))).toBeUndefined();
  });

  test("reproduces the samples it was given, exactly", () => {
    const property = filled();
    for (let index = 0; index < 10; index += 1) {
      const value = property.getValue(at(index * STEP)) as Cartesian3;
      expect(value.x).toBeCloseTo(index * 100, 6);
      expect(value.y).toBeCloseTo(index * -200, 6);
      expect(value.z).toBeCloseTo(7000, 6);
    }
  });

  test("interpolates a straight line without bending it", () => {
    // A polynomial through collinear points is that line, so any error is in the basis.
    const property = filled();
    const value = property.getValue(at(3.25 * STEP)) as Cartesian3;
    expect(value.x).toBeCloseTo(325, 6);
    expect(value.y).toBeCloseTo(-650, 6);
  });

  test("holds the end value rather than extrapolating past it", () => {
    // Extrapolating would be wildly off; a held sample is stale but bounded.
    const property = filled(0, 6);
    expect((property.getValue(at(5 * STEP)) as Cartesian3).x).toBeCloseTo(500, 6);
    expect((property.getValue(at(20 * STEP)) as Cartesian3).x).toBeCloseTo(500, 6);
    expect((property.getValue(at(-40 * STEP)) as Cartesian3).x).toBeCloseTo(0, 6);
  });

  test("holds the nearest sample when there are too few for a cubic", () => {
    const property = new GridPositionProperty();
    property.reset(ANCHOR_MS, STEP);
    property.add(4, ramp(4, 2));
    expect((property.getValue(at(4 * STEP)) as Cartesian3).x).toBeCloseTo(400, 6);
    expect((property.getValue(at(5 * STEP)) as Cartesian3).x).toBeCloseTo(500, 6);
  });

  test("reads the same instant from either end of a seam", () => {
    const forwards = filled(0, 6);
    forwards.add(6, ramp(6, 6));
    const backwards = filled(6, 6);
    backwards.add(0, ramp(0, 6));

    expect(forwards.length).toBe(12);
    expect(backwards.length).toBe(12);
    for (const seconds of [5.5 * STEP, 6 * STEP, 6.5 * STEP]) {
      expect((forwards.getValue(at(seconds)) as Cartesian3).x).toBeCloseTo((backwards.getValue(at(seconds)) as Cartesian3).x, 6);
    }
  });

  test("overwrites an interval it already holds instead of duplicating it", () => {
    const property = filled(0, 10);
    const rewritten = new Float64Array(9).fill(42);
    expect(property.add(3, rewritten)).toBe(true);
    expect(property.length).toBe(10);
    expect((property.getValue(at(4 * STEP)) as Cartesian3).x).toBeCloseTo(42, 6);
  });

  test("a batch that extends the front and overlaps is taken whole", () => {
    const property = filled(6, 4);
    expect(property.add(2, ramp(2, 8))).toBe(true);
    expect(property.firstIndex).toBe(2);
    expect(property.length).toBe(8);
    expect((property.getValue(at(3 * STEP)) as Cartesian3).x).toBeCloseTo(300, 6);
    expect((property.getValue(at(9 * STEP)) as Cartesian3).x).toBeCloseTo(900, 6);
  });

  test("a batch that swallows the window whole keeps all of it", () => {
    const property = filled(6, 3);
    expect(property.add(4, ramp(4, 10))).toBe(true);
    expect(property.firstIndex).toBe(4);
    expect(property.length).toBe(10);
    expect((property.getValue(at(13 * STEP)) as Cartesian3).x).toBeCloseTo(1300, 6);
  });

  test("refuses a batch that would leave a hole", () => {
    const property = filled(0, 5);
    // Grid indices 5..7 are missing.
    expect(property.add(8, ramp(8, 3))).toBe(false);
    expect(property.length).toBe(5);
  });

  test("drops from either end without moving the samples that remain", () => {
    const property = filled(0, 12);
    property.dropBefore(4);
    expect(property.firstIndex).toBe(4);
    expect(property.length).toBe(8);
    property.dropAfter(9);
    expect(property.length).toBe(6);
    expect((property.getValue(at(7 * STEP)) as Cartesian3).x).toBeCloseTo(700, 6);
  });

  test("keeps reading correctly after a window slides and refills", () => {
    const property = filled(0, 12);
    property.dropBefore(6);
    expect(property.add(12, ramp(12, 6))).toBe(true);
    expect(property.firstIndex).toBe(6);
    expect(property.length).toBe(12);
    expect((property.getValue(at(13.5 * STEP)) as Cartesian3).x).toBeCloseTo(1350, 6);
    expect((property.getValue(at(8 * STEP)) as Cartesian3).x).toBeCloseTo(800, 6);
  });

  test("a different anchor or step starts the grid over", () => {
    const property = filled();
    expect(property.isOnGrid(ANCHOR_MS, STEP)).toBe(true);
    expect(property.isOnGrid(ANCHOR_MS + 1, STEP)).toBe(false);
    expect(property.isOnGrid(ANCHOR_MS, STEP + 1)).toBe(false);
    property.reset(ANCHOR_MS, 60);
    expect(property.length).toBe(0);
  });

  test("turns a grid index back into the instant it stands for", () => {
    const property = filled();
    expect(JulianDate.secondsDifference(property.timeAt(4), anchor())).toBeCloseTo(4 * STEP, 6);
    expect(property.indexAtOrAfter(at(4 * STEP))).toBe(4);
    expect(property.indexAtOrAfter(at(4.1 * STEP))).toBe(5);
  });

  test("converts out of its own reference frame on request", () => {
    const property = filled();
    const own = property.getValueInReferenceFrame(at(2 * STEP), ReferenceFrame.FIXED) as Cartesian3;
    const other = property.getValueInReferenceFrame(at(2 * STEP), ReferenceFrame.INERTIAL);
    expect(own.x).toBeCloseTo(200, 6);
    // Without Cesium's transform data the conversion may decline.
    if (other) {
      expect(other.x).not.toBeCloseTo(200, 6);
    }
  });

  test("drives an entity the way Cesium's own position properties do", () => {
    // VelocityVectorProperty subscribes via `value._definitionChanged`, not the getter,
    // so only a real Entity catches a property that lacks the field.
    const property = filled();
    const entity = new Entity({ name: "grid", position: property as never });
    entity.orientation = new VelocityOrientationProperty(property as never);

    expect(entity.position).toBe(property);
    expect((entity.position!.getValue(at(2 * STEP)) as Cartesian3).x).toBeCloseTo(200, 6);
    expect(entity.orientation.getValue(at(2 * STEP))).toBeDefined();
  });

  test("raises definitionChanged when what it holds changes", () => {
    const property = filled();
    let raised = 0;
    property.definitionChanged.addEventListener(() => {
      raised += 1;
    });
    property.add(10, ramp(10, 4));
    expect(raised).toBe(1);
  });

  test("hands back the raw samples for a range", () => {
    const property = filled(0, 10);
    const positions = property.rawPositions(2, 4);
    expect(positions).toHaveLength(3);
    expect(positions[0]?.x).toBeCloseTo(200, 6);
    // Clamped to what is held, not padded.
    expect(property.rawPositions(-5, 100)).toHaveLength(10);
  });
});
