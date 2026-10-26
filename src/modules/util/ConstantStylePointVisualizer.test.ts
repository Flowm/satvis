import { Cartesian3, Color, JulianDate } from "@cesium/core";
import { CallbackProperty, ConstantProperty, Entity, EntityCluster, EntityCollection, PointGraphics, PointVisualizer } from "@cesium/engine";
import { describe, expect, test } from "vitest";

import { ConstantStylePointVisualizer } from "./ConstantStylePointVisualizer";

const START = JulianDate.fromIso8601("2026-10-26T00:00:00Z");
const at = (seconds: number) => JulianDate.addSeconds(START, seconds, new JulianDate());

/** One collection of three moving points, one with a colour that changes by itself. */
function world(Visualizer: typeof PointVisualizer) {
  const cluster = new EntityCluster();
  const entities = new EntityCollection();
  const moving = (offset: number) =>
    new CallbackProperty((time, result?: Cartesian3) => Cartesian3.fromElements(7e6 + offset, JulianDate.secondsDifference(time!, START) * 1000, 0, result), false);
  const plain = entities.add(
    new Entity({ id: "plain", position: moving(0) as never, point: new PointGraphics({ pixelSize: 4, color: Color.RED, outlineColor: Color.DIMGREY, outlineWidth: 1 }) }),
  );
  const pulsing = entities.add(
    new Entity({
      id: "pulsing",
      position: moving(1) as never,
      point: new PointGraphics({ color: new CallbackProperty((time) => Color.WHITE.withAlpha((JulianDate.secondsDifference(time!, START) % 10) / 10), false) }),
    }),
  );
  const toggled = entities.add(
    new Entity({
      id: "toggled",
      position: moving(2) as never,
      point: new PointGraphics({ show: new CallbackProperty((time) => JulianDate.secondsDifference(time!, START) < 3, false) }),
    }),
  );
  const visualizer = new Visualizer(cluster, entities);
  /** What each entity's primitive draws, undefined where it has none. */
  const drawn = () =>
    Object.fromEntries(
      [plain, pulsing, toggled].map((entity) => {
        const point = (cluster as unknown as { _pointCollection?: { _pointPrimitives: { id: unknown; show: boolean }[] } })._pointCollection?._pointPrimitives.find(
          (candidate) => candidate.id === entity && candidate.show,
        ) as { position: Cartesian3; color: Color; outlineColor: Color; pixelSize: number; outlineWidth: number } | undefined;
        return [
          entity.id,
          point && {
            position: Cartesian3.clone(point.position),
            color: point.color.clone(),
            outlineColor: point.outlineColor.clone(),
            pixelSize: point.pixelSize,
            outlineWidth: point.outlineWidth,
          },
        ];
      }),
    );
  return { visualizer, plain, pulsing, toggled, drawn };
}

describe("ConstantStylePointVisualizer", () => {
  test("draws what Cesium's PointVisualizer draws, tick by tick", () => {
    const cesium = world(PointVisualizer);
    const ours = world(ConstantStylePointVisualizer);
    const script: ((w: ReturnType<typeof world>) => void)[] = [
      () => {},
      () => {},
      (w) => (w.plain.point!.color = new ConstantProperty(Color.BLUE)),
      () => {},
      (w) => (w.plain.show = false),
      () => {},
      (w) => (w.plain.show = true),
      (w) => (w.plain.point!.pixelSize = new ConstantProperty(6)),
      () => {},
    ];
    script.forEach((step, second) => {
      for (const w of [cesium, ours]) {
        step(w);
        w.visualizer.update(at(second));
      }
      expect(ours.drawn(), `after second ${second}`).toEqual(cesium.drawn());
    });
    // The script must have exercised what it claims to.
    expect(ours.drawn().toggled).toBeUndefined();
    expect(ours.drawn().plain?.pixelSize).toBe(6);
  });
});
