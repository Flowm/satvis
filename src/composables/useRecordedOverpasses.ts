import { computed, onScopeDispose, reactive, type Ref, shallowRef, watch } from "vue";

import { useController } from "@/composables/useController";
import { useOverpassReplay } from "@/composables/useOverpassReplay";
import { type GranuleLayer, isGranuleLayer, readImageryList } from "@/config/instrumentImagery";
import { hasPixels, isDayOverpass, stationOverpasses, stationReplay } from "@/modules/overpassReplay";
import { type PassImagery, passImagery, type RecordedOverpass } from "@/modules/passImagery";

/** How many satellite and station pairs are asked of CMR at once: a satellite's passes cover every station. */
const MAX_PAIRS = 10;

/**
 * The overpasses CMR lists of the passes in view (ADR 0023): for each satellite with a
 * granule layer and station among `passes`, the last STATION_DAYS over the station, which the
 * Passes table matches to its rows, with whether their pictures have their pixels and a replay of each.
 */
export function useRecordedOverpasses(passes: Ref<readonly { name: string; groundStationName?: string }[]>) {
  const cc = useController();
  const { sats } = cc;
  const replay = useOverpassReplay();

  // The pairs to ask about, as a key that changes only when they do.
  const pairs = computed(() => {
    const found = new Map<string, { satellite: string; station: string; layer: GranuleLayer; latitude: number; longitude: number }>();
    for (const { name, groundStationName } of passes.value) {
      if (groundStationName === undefined || found.size >= MAX_PAIRS) continue;
      const station = sats.groundStations.find((gs) => gs.name === groundStationName);
      const metadata = sats.getSatellite(name)?.props.metadata;
      if (station === undefined || metadata === undefined) continue;
      for (const { drawn, merged } of readImageryList(metadata.imagery)) {
        const { latitude, longitude } = station.position;
        const key = `${name}|${groundStationName}|${drawn?.token}|${latitude}|${longitude}`;
        if (!merged && isGranuleLayer(drawn) && !found.has(key)) {
          found.set(key, { satellite: name, station: groundStationName, layer: drawn, latitude, longitude });
        }
      }
    }
    return found;
  });
  const pairsKey = computed(() => [...pairs.value.keys()].toSorted().join("\n"));

  // By pair, as `pairs` keys them.
  const byPair = shallowRef(new Map<string, RecordedOverpass[]>());
  const recorded = computed(() => [...byPair.value.values()].flat());
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
          if (controller.signal.aborted || overpasses === undefined) return;
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
   * granules, and the replay bar steps through the satellite's others there; any other pass
   * stops the replay, whose granules are of another pass.
   */
  function replayPass(pass: { start: number; groundStationName?: string }, entry: RecordedOverpass | undefined): void {
    const station = sats.groundStations.find((gs) => gs.name === (entry?.station ?? pass.groundStationName));
    if (station === undefined) return;
    const point = { latitude: station.position.latitude, longitude: station.position.longitude };
    if (entry === undefined || !entry.day) {
      replay.stop();
      cc.replay(stationReplay(pass, point));
      return;
    }
    const overpasses = (byPair.value.get(entry.pair) ?? []).filter((other) => other.day).map((other) => other.overpass);
    replay.start(entry.layer, entry.satellite, stationReplay(entry.overpass, point), entry.station, overpasses);
  }

  return { recorded, imageryOf, replayPass };
}
