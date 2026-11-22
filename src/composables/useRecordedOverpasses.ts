import { computed, onScopeDispose, reactive, type Ref, shallowRef, watch } from "vue";

import { useController } from "@/composables/useController";
import { useOverpassReplay } from "@/composables/useOverpassReplay";
import type { Selection } from "@/composables/useSelectedEntity";
import { type GranuleLayer, isGranuleLayer, readImageryList } from "@/config/instrumentImagery";
import { hasPixels, isDayOverpass, stationOverpasses, stationReplay } from "@/modules/overpassReplay";
import { type PassImagery, passImagery, type RecordedOverpass, replaySteps } from "@/modules/passImagery";

/** Each satellite's own granule layers, by its metadata, which is read once. */
const granuleLayersOf = new WeakMap<object, GranuleLayer[]>();

/** The granule layers of a satellite's own instruments, not of composites it is merged into. */
function ownGranuleLayers(metadata: { imagery?: unknown }): GranuleLayer[] {
  let layers = granuleLayersOf.get(metadata);
  if (layers === undefined) {
    layers = readImageryList(metadata.imagery).flatMap(({ drawn, merged }) => (!merged && isGranuleLayer(drawn) ? [drawn] : []));
    granuleLayersOf.set(metadata, layers);
  }
  return layers;
}

/**
 * The overpasses CMR lists for the Passes table of `selection` (ADR 0023): of every drawn
 * satellite with a granule layer over a selected station, or of a selected satellite over
 * every station, the last STATION_DAYS, whether or not a pass is predicted in view. The table
 * matches them to its rows, with whether their pictures have their pixels and a replay of
 * each; a replay steps through them all. `passes` is recomputed as the drawn satellites and
 * stations change, which are not reactive themselves.
 */
export function useRecordedOverpasses(selection: Ref<Selection | null>, passes: Ref<readonly unknown[]>) {
  const cc = useController();
  const { sats } = cc;
  const replay = useOverpassReplay();

  // The pairs to ask about, as a key that changes only when they do.
  const pairs = computed(() => {
    void passes.value;
    const found = new Map<string, { satellite: string; station: string; layer: GranuleLayer; latitude: number; longitude: number }>();
    const selected = selection.value;
    if (selected === null) return found;
    const satellites = selected.kind === "satellite" ? [selected.sat] : sats.activeSatellites;
    const stations = selected.kind === "groundstation" ? [selected.gs] : sats.groundStations;
    for (const sat of satellites) {
      for (const layer of ownGranuleLayers(sat.props.metadata)) {
        for (const station of stations) {
          const { latitude, longitude } = station.position;
          const key = `${sat.props.name}|${station.name}|${layer.token}|${latitude}|${longitude}`;
          found.set(key, { satellite: sat.props.name, station: station.name, layer, latitude, longitude });
        }
      }
    }
    return found;
  });
  const pairsKey = computed(() => [...pairs.value.keys()].toSorted().join("\n"));

  // By pair, as `pairs` keys them.
  const byPair = shallowRef(new Map<string, RecordedOverpass[]>());
  const recorded = computed(() => [...byPair.value.values()].flat());
  /** Every pair asked about has answered, or failed to. */
  const settled = computed(() => [...pairs.value.keys()].every((key) => byPair.value.has(key)));
  // Every pair's overpasses once listed: the passes empty while they are computed, as after a replay's jump.
  const listed = new Map<string, RecordedOverpass[]>();
  // The pictures' answer for each day granule of an overpass, by overpass.
  const pixels = reactive(new Map<RecordedOverpass, boolean[]>());
  const asked = new Set<RecordedOverpass>();
  const alive = new AbortController();
  let asking: AbortController | undefined;

  watch(
    pairsKey,
    () => {
      asking?.abort();
      const controller = new AbortController();
      asking = controller;
      byPair.value = new Map([...pairs.value.keys()].flatMap((key) => (listed.has(key) ? [[key, listed.get(key)!]] : [])));
      for (const [key, { satellite, station, layer, latitude, longitude }] of pairs.value) {
        if (listed.has(key)) continue;
        void stationOverpasses(layer, { latitude, longitude }, controller.signal).then((overpasses) => {
          if (controller.signal.aborted) return;
          if (overpasses === undefined) {
            // Not kept in `listed`, so it is asked again; none for now, so the rest settle.
            byPair.value = new Map(byPair.value).set(key, []);
            return;
          }
          const entries = overpasses.map((overpass) => ({ pair: key, satellite, station, layer, overpass, day: isDayOverpass(overpass) }));
          listed.set(key, entries);
          byPair.value = new Map(byPair.value).set(key, entries);
        });
      }
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    asking?.abort();
    alive.abort();
  });

  /** What the overpass shows; asks the pictures' provider the first time it is wanted. */
  function imageryOf(entry: RecordedOverpass): PassImagery {
    const { signal } = alive;
    if (entry.day && entry.layer.pictures !== undefined && !asked.has(entry)) {
      asked.add(entry);
      const granules = entry.overpass.granules.filter((granule) => granule.day);
      void Promise.all(granules.map((granule) => hasPixels(entry.layer, granule))).then((answers) => {
        if (!signal.aborted) pixels.set(entry, answers);
      });
    }
    return passImagery(entry, pixels.get(entry));
  }

  /**
   * Replays a pass over its station (stationReplay). A pass CMR recorded by day also shows its
   * granules, and the replay bar steps through the table's other recorded overpasses
   * (replaySteps); any other pass stops the replay, whose granules are of another pass.
   */
  function replayPass(pass: { name?: string; start: number; groundStationName?: string }, entry: RecordedOverpass | undefined): void {
    if (entry !== undefined && entry.day) {
      replay.start(entry, replaySteps(recorded.value, entry));
      return;
    }
    const point = pass.groundStationName === undefined ? undefined : sats.stationPoint(pass.groundStationName);
    if (point === undefined || pass.name === undefined) return;
    replay.stop({ returnView: false });
    cc.replay(stationReplay(pass, point, pass.name), replay.camera.value);
  }

  return { recorded, settled, imageryOf, replayPass };
}
