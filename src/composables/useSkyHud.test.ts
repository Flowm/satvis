import { Math as CesiumMath } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { fovxFromFovy, MAX_FOVY, MIN_FOVY } from "../modules/SkyView";
import { headingOffset, majorStep, stepFor, TICKS_WANTED } from "./useSkyHud";

const span = (fovy: number, width: number, height: number): number => CesiumMath.toDegrees(fovxFromFovy(CesiumMath.toRadians(fovy), width / height));

const PHONE = [390, 844] as const;
const DESKTOP = [1600, 900] as const;
const WIDE = [2560, 1080] as const;

describe("stepFor", () => {
  test("leaves a landscape desktop at the default zoom where it always was", () => {
    expect(stepFor(span(75, ...DESKTOP))).toBe(15);
  });

  test("goes finer on a portrait phone, whose span is a third of that", () => {
    expect(Math.round(span(75, ...PHONE))).toBe(39);
    expect(stepFor(span(75, ...PHONE))).toBe(5);
  });

  test("keeps the tape populated at maximum zoom, which is what fixed steps did not", () => {
    // ~4.6° across on a phone.
    expect(stepFor(span(MIN_FOVY, ...PHONE))).toBe(1);
    expect(stepFor(span(MIN_FOVY, ...DESKTOP))).toBe(5);
  });

  test("never asks for fewer than three marks anywhere in the zoom range", () => {
    for (const [width, height] of [PHONE, DESKTOP, WIDE, [1000, 1000] as const]) {
      for (let fovy = MIN_FOVY; fovy <= MAX_FOVY; fovy += 0.5) {
        const across = span(fovy, width, height);
        expect(across / stepFor(across), `${width}x${height} at ${fovy}°`).toBeGreaterThanOrEqual(TICKS_WANTED);
      }
    }
  });

  test("and no more than ten on any viewport it will meet", () => {
    // Above a 45° span the count grows with the span: fovy 100 on 21:9 gives 141°/15 = 9.4.
    for (const [width, height] of [PHONE, DESKTOP, WIDE, [1000, 1000] as const]) {
      for (let fovy = MIN_FOVY; fovy <= MAX_FOVY; fovy += 0.5) {
        const across = span(fovy, width, height);
        expect(across / stepFor(across), `${width}x${height} at ${fovy}°`).toBeLessThan(10);
      }
    }
  });
});

/** Built from the camera basis, not the module, so the tape is checked against geometry. */
function projectedHorizonOffset(deltaAzimuth: number, pitch: number, halfWidth: number, tanHalfSpan: number): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  // In the observer's east-north-up frame, with the view azimuth taken as north.
  const forward = [0, Math.cos(rad(pitch)), Math.sin(rad(pitch))];
  const right = [1, 0, 0];
  const bearing = [Math.sin(rad(deltaAzimuth)), Math.cos(rad(deltaAzimuth)), 0];
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  return halfWidth + (halfWidth * (dot(bearing, right) / dot(bearing, forward))) / tanHalfSpan;
}

describe("headingOffset", () => {
  const HALF_WIDTH = 195;
  const tanHalfSpan = Math.tan((Math.PI / 180 / 2) * 39); // a 39° span, a phone at default zoom

  test("is the crosshair for the bearing being looked at", () => {
    expect(headingOffset(0, HALF_WIDTH, tanHalfSpan)).toBeCloseTo(HALF_WIDTH, 9);
  });

  test("puts the edge of the span at the edge of the viewport", () => {
    expect(headingOffset(19.5, HALF_WIDTH, tanHalfSpan)).toBeCloseTo(HALF_WIDTH * 2, 6);
    expect(headingOffset(-19.5, HALF_WIDTH, tanHalfSpan)).toBeCloseTo(0, 6);
  });

  test("matches the true projection exactly at eye level", () => {
    for (const delta of [-19.5, -10, -1, 0, 1, 10, 19.5]) {
      expect(headingOffset(delta, HALF_WIDTH, tanHalfSpan), `Δ${delta}°`).toBeCloseTo(projectedHorizonOffset(delta, 0, HALF_WIDTH, tanHalfSpan), 6);
    }
  });

  test("holds its scale where the projection would grow by 1/cos(pitch)", () => {
    // The readout takes no pitch, so it diverges from the projection by exactly 1/cos(pitch).
    const stable = headingOffset(10, HALF_WIDTH, tanHalfSpan) - HALF_WIDTH;
    for (const pitch of [0, 30, 60, 85]) {
      const projected = projectedHorizonOffset(10, pitch, HALF_WIDTH, tanHalfSpan) - HALF_WIDTH;
      expect(projected / stable, `pitch ${pitch}°`).toBeCloseTo(1 / Math.cos((pitch * Math.PI) / 180), 6);
    }
  });
});

describe("majorStep", () => {
  test("keeps the compass points among the majors at every rung", () => {
    for (const step of [15, 5, 3, 1]) {
      expect(45 % majorStep(step), `step ${step}`).toBe(0);
    }
  });

  test("labels every third tick", () => {
    expect(majorStep(15)).toBe(45);
    expect(majorStep(5)).toBe(15);
    expect(majorStep(1)).toBe(3);
  });
});
