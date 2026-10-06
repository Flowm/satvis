// An orbit does not close on itself: the ISS drifts ~31 km a period, NOAA 20 ~54 km.
// Closed straight back to its head the line bent by 7.6–42°; started at the first
// sample it left the satellite up to 7 km off. The unit tests stand TEME in for ICRF;
// this uses Cesium's IAU data.

import type { Page } from "@playwright/test";

import { openApp } from "../support/app";
import { expect, test } from "../support/test";

const SATELLITES = ["ISS (ZARYA)", "NOAA 20 (JPSS-1)"];

/**
 * For a start `offset` seconds after the clock (or, with "lastSample", the latest start
 * whose period still ends past the last sample): the largest bend between consecutive
 * segments, in degrees, and the satellite's largest distance from the line over the
 * next three quarters of a period, in km.
 */
const measure = (page: Page, name: string, offset: number | "lastSample") =>
  page.evaluate(
    (wanted) => {
      const INERTIAL = 1; // Cesium's ReferenceFrame.INERTIAL
      const { viewer, sats } = window.cc!;
      const sat = sats.activeSatellites.find((candidate) => candidate.props.name === wanted.name)!;
      const trajectory = sat.props.trajectory;
      const JulianDate = viewer.clock.currentTime.constructor as unknown as {
        addSeconds: (time: unknown, seconds: number, result: unknown) => typeof viewer.clock.currentTime;
      };
      const later = (seconds: number, from = viewer.clock.currentTime) => JulianDate.addSeconds(from, seconds, from.clone());
      const periodSeconds = sat.props.orbit.orbitalPeriod * 60;
      trajectory.requireInertial();
      const start = wanted.offset === "lastSample" ? later(1 - periodSeconds, trajectory.inertial!.lastTime()!) : later(wanted.offset);

      const line = trajectory.positionsForNextOrbit(start).map((p) => [p.x, p.y, p.z]);
      const sub = (a: number[], b: number[]) => a.map((value, index) => value - b[index]!);
      const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);
      const length = (a: number[]) => Math.sqrt(dot(a, a));

      let bend = 0;
      for (let index = 2; index < line.length; index += 1) {
        const [u, v] = [sub(line[index - 1]!, line[index - 2]!), sub(line[index]!, line[index - 1]!)];
        bend = Math.max(bend, (Math.acos(Math.min(1, dot(u, v) / (length(u) * length(v)))) * 180) / Math.PI);
      }

      let gap = 0;
      for (let seconds = 0; seconds <= 0.75 * periodSeconds; seconds += 20) {
        const at = trajectory.inertial!.getValueInReferenceFrame(later(seconds, start), INERTIAL)!;
        const point = [at.x, at.y, at.z];
        let nearest = Infinity;
        for (let index = 1; index < line.length; index += 1) {
          const [a, b] = [line[index - 1]!, line[index]!];
          const ab = sub(b, a);
          const t = Math.max(0, Math.min(1, dot(sub(point, a), ab) / dot(ab, ab)));
          nearest = Math.min(
            nearest,
            length(
              sub(
                point,
                a.map((value, i) => value + t * ab[i]!),
              ),
            ),
          );
        }
        gap = Math.max(gap, nearest / 1000);
      }
      return { bend, gap, points: line.length };
    },
    { name, offset },
  );

test("the orbit line bends no more than its sampling, and the satellite stays on it", async ({ page }) => {
  await openApp(page, `tags=&sats=${SATELLITES.map(encodeURIComponent).join(",")}&elements=Point,Orbit`);
  await page.evaluate(() => (window.cc!.viewer.clock.shouldAnimate = false));

  for (const name of SATELLITES) {
    for (const offset of [0.5, 5, 20, 40, "lastSample"] as const) {
      const { bend, gap, points } = await measure(page, name, offset);
      const at = `${name}, start ${offset}`;
      expect.soft(points, at).toBeGreaterThan(100);
      // 120 samples an orbit bend 3° on their own.
      expect.soft(bend, `${at}: bend in degrees`).toBeLessThan(3.5);
      // The chord between samples: 2.3–2.5 km measured.
      expect.soft(gap, `${at}: gap in km`).toBeLessThan(3);
    }
  }
});
