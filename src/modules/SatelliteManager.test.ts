import { JulianDate } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type DesiredScene, SatelliteManager } from "./SatelliteManager";
import { parseGpPayload } from "./util/gp";
import { InlinePassSource } from "./util/passSource";
import { InlineSampleSource } from "./util/sampleSource";

const TLES = [
  "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658",
  "NOAA 20\n1 43013U 17073A   18342.50000000  .00000010  00000-0  25000-4 0  9990\n2 43013  98.7400 280.0000 0001000  90.0000 270.0000 14.19500000 54000",
].join("\n");

/** The parts of a viewer the manager and its satellites touch, with entities recorded. */
function fakeViewer() {
  const entities = new Set<unknown>();
  const listeners = () => {
    const set = new Set<() => void>();
    return { addEventListener: (listener: () => void) => (set.add(listener), () => set.delete(listener)), raise: () => set.forEach((listener) => listener()) };
  };
  const viewer = {
    clock: { currentTime: JulianDate.fromIso8601("2018-12-08T00:00:00Z"), shouldAnimate: false, onTick: listeners() },
    scene: { requestRender: () => {}, primitives: { add: () => {}, remove: () => true }, postRender: listeners(), mode: 3 },
    camera: { cancelFlight: () => {} },
    entities: { add: (e: unknown) => entities.add(e) && e, remove: (e: unknown) => entities.delete(e), contains: (e: unknown) => entities.has(e), size: () => entities.size },
    selectedEntity: undefined,
    trackedEntity: undefined,
    selectedEntityChanged: listeners(),
    trackedEntityChanged: listeners(),
  };
  return viewer as unknown as Viewer;
}

const scene = (desired: Partial<DesiredScene>): DesiredScene => ({
  enabledTags: [],
  enabledSatellites: [],
  disabledSatellites: [],
  components: ["Point"],
  groundStations: [],
  overpassMode: "elevation",
  trackedSatellite: "",
  ...desired,
});

function setup() {
  const viewer = fakeViewer();
  const sats = new SatelliteManager(viewer, { samples: new InlineSampleSource(), passes: new InlinePassSource() });
  sats.addCustomRecords(parseGpPayload(TLES), ["Test"]);
  return { sats, entityCount: () => (viewer.entities as unknown as { size: () => number }).size() };
}

beforeEach(() => {
  // The build steps a frame at a time; Node has no frames.
  vi.stubGlobal("requestAnimationFrame", (step: () => void) => setTimeout(step, 0));
  vi.stubGlobal("cancelAnimationFrame", (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SatelliteManager", () => {
  test("builds the satellites a tag enables, each once, however often it is reconciled", async () => {
    const { sats, entityCount } = setup();

    sats.reconcile(scene({ enabledTags: ["Test"] }));
    sats.reconcile(scene({ enabledTags: ["Test"], components: ["Point", "Label"] }));
    await sats.buildSettled();

    expect(sats.activeSatellites.map((sat) => sat.props.name).toSorted()).toEqual(["ISS (ZARYA)", "NOAA 20"]);
    expect(sats.activeSatellites.every((sat) => sat.componentNames.join() === "Point,Label")).toBe(true);
    // db9f546: a reconcile while windows were in flight built a satellite twice and leaked the first.
    expect(entityCount()).toBe(4);
  });

  test("drops a satellite whose tag is switched off, and builds it again when it comes back", async () => {
    const { sats } = setup();
    sats.reconcile(scene({ enabledTags: ["Test"] }));
    await sats.buildSettled();

    sats.reconcile(scene({ enabledTags: ["Test"], disabledSatellites: ["NOAA 20"] }));
    await sats.buildSettled();
    expect(sats.activeSatellites.map((sat) => sat.props.name)).toEqual(["ISS (ZARYA)"]);

    sats.reconcile(scene({ enabledTags: ["Test"] }));
    await sats.buildSettled();
    expect(sats.activeSatellites).toHaveLength(2);
    expect(sats.getSatellite("NOAA 20")?.componentNames).toEqual(["Point"]);
  });
});
