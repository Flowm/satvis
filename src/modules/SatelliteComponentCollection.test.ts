// The ground-station link's lifecycle — GitHub issue #83. Real Cesium Entity/
// PolylineGraphics objects construct fine in the node env (see
// PolylineBatch.test.ts); what is faked is the viewer, matching that file's
// pattern, extended with the entities collection and the two event emitters
// SatelliteComponentCollection.init() subscribes to.

import { Entity, JulianDate } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { describe, expect, test } from "vitest";

import type { GroundStation } from "./PassPredictor";
import { CatalogEntry } from "./SatelliteCatalog";
import { SatelliteComponentCollection } from "./SatelliteComponentCollection";
import { parseGpPayload, type GpRecord } from "./util/gp";
import { InlinePassSource } from "./util/passSource";
import { PolylineBatch } from "./util/PolylineBatch";
import { InlineSampleSource } from "./util/sampleSource";

const GROUND_STATION_LINK = "Ground station link";

const TLE = "ISS (ZARYA)\n1 25544U 98067A   18342.69352573  .00002284  00000-0  41838-4 0  9992\n2 25544  51.6407 229.0798 0005166 124.8351 329.3296 15.54069892145658";

function issEntry(): CatalogEntry {
  const record = parseGpPayload(TLE)[0] as GpRecord;
  return new CatalogEntry({ key: "25544|ISS", name: "ISS", nameUpper: "ISS", satnum: "25544", tags: [], record });
}

const munich = (): GroundStation => ({ name: "Munich", position: { latitude: 48.14, longitude: 11.58, height: 0 } });
const berlin = (): GroundStation => ({ name: "Berlin", position: { latitude: 52.52, longitude: 13.4, height: 0 } });

/** A viewer whose entities collection records every add/remove, like PolylineBatch.test.ts's fake primitives. */
function fakeViewer() {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const entitySet = new Set<unknown>();
  const listeners = new Set<() => void>();
  const viewer = {
    clock: {
      currentTime: JulianDate.fromIso8601("2026-01-01T00:00:00Z"),
      shouldAnimate: false,
      onTick: {
        addEventListener(listener: () => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    scene: {
      requestRender: () => {},
      primitives: { add: () => {}, remove: () => true },
      mode: 3,
      frameState: {},
    },
    entities: {
      add: (e: unknown) => {
        added.push(e);
        entitySet.add(e);
        return e;
      },
      remove: (e: unknown) => {
        removed.push(e);
        return entitySet.delete(e);
      },
      contains: (e: unknown) => entitySet.has(e),
    },
    selectedEntity: undefined,
    trackedEntity: undefined,
    selectedEntityChanged: { addEventListener: () => () => {} },
    trackedEntityChanged: { addEventListener: () => () => {} },
    dataSourceDisplay: undefined,
  };
  return { viewer: viewer as unknown as Viewer, added, removed };
}

/** A collection with a valid, adopted trajectory — everything short of show()/groundStations=, which each test orders for itself. */
async function setup() {
  const { viewer, added, removed } = fakeViewer();
  const orbits = new PolylineBatch(viewer, "inertial");
  const tracks = new PolylineBatch(viewer, "fixed");
  const entry = issEntry();
  const sampler = new InlineSampleSource().samplerFor(entry.satnum, entry.record);
  const predictor = new InlinePassSource().predictorFor(entry.satnum, entry.record);
  const sat = new SatelliteComponentCollection(viewer, entry, { orbits, tracks }, sampler, predictor);

  const nowMs = JulianDate.toDate(viewer.clock.currentTime).getTime();
  const chunk = await sampler.samples(nowMs - 3600_000, nowMs + 3600_000);
  if (chunk) sat.props.trajectory.adopt(chunk);

  return { sat, added, removed };
}

describe("SatelliteComponentCollection ground-station link (#83)", () => {
  test("a ground station set before any component is shown still gets created and attached", async () => {
    const { sat, added } = await setup();

    sat.groundStations = [munich()];
    sat.show(["Point"]);

    const link = sat.components[GROUND_STATION_LINK];
    expect(link).toBeInstanceOf(Entity);
    expect(added).toContain(link);
  });

  test("a ground station added after visual components exist reaches viewer.entities, and a later change does not duplicate it", async () => {
    const { sat, added } = await setup();
    sat.show(["Point", "Label"]);

    sat.groundStations = [munich()];
    const link = sat.components[GROUND_STATION_LINK];
    expect(link).toBeInstanceOf(Entity);
    expect(added.filter((e) => e === link)).toHaveLength(1);

    sat.groundStations = [munich(), berlin()];
    expect(sat.components[GROUND_STATION_LINK]).toBe(link); // same entity, not recreated
    expect(added.filter((e) => e === link)).toHaveLength(1); // not added a second time
  });

  test("removing every ground station removes the link from the scene and from componentNames, leaving other components alone", async () => {
    const { sat, removed } = await setup();
    sat.show(["Point", "Label"]);
    sat.groundStations = [munich()];
    const link = sat.components[GROUND_STATION_LINK];

    sat.groundStations = [];

    expect(sat.componentNames).not.toContain(GROUND_STATION_LINK);
    expect(removed).toContain(link);
    expect(sat.componentNames.toSorted()).toEqual(["Label", "Point"]);
  });

  test("dispose() removes the ground-station link along with everything else and clears lifecycle listeners", async () => {
    const { sat, removed } = await setup();
    sat.show(["Point"]);
    sat.groundStations = [munich()];
    const link = sat.components[GROUND_STATION_LINK];
    expect(Object.keys(sat.eventListeners).length).toBeGreaterThan(0);

    sat.dispose();

    expect(sat.componentNames).toEqual([]);
    expect(removed).toContain(link);
    expect(sat.eventListeners).toEqual({});
  });

  // Not one of the four scenarios above, but the concern raised reviewing the
  // fix: enableComponent() assigns `defaultEntity` to the first Entity it
  // adds. SatelliteManager.#instantiate shows the user's chosen components
  // before setting groundStations specifically so Point stays first —
  // without that order, a satellite with a ground station already configured
  // would default to the link (invisible outside a pass) instead of to Point,
  // changing what track()/the sky view's onSelect hand the camera and the
  // entity info panel.
  test("defaultEntity stays the visual component when groundStations is set after show(), matching SatelliteManager's order", async () => {
    const { sat } = await setup();
    sat.show(["Point"]);
    sat.groundStations = [munich()];

    expect(sat.defaultEntity).toBe(sat.components.Point);
    expect(sat.defaultEntity).not.toBe(sat.components[GROUND_STATION_LINK]);
  });
});
