import { computed, onScopeDispose, reactive, type Ref, shallowRef, watch } from "vue";

import { useController } from "@/composables/useController";
import { useOverpassReplay } from "@/composables/useOverpassReplay";
import { type GranuleLayer, isGranuleLayer, readImageryList } from "@/config/instrumentImagery";
import { hasPixels, isDayOverpass, stationOverpasses, stationReplay } from "@/modules/overpassReplay";
import { type PassImagery, passImagery, type RecordedOverpass } from "@/modules/passImagery";

/** How many satellite and station pairs are asked of CMR at once: a satellite's passes cover every station. */
const MAX_PAIRS = 6;

/**
 * The overpasses CMR lists of the passes in view (ADR 0023): for each satellite with a
 * granule layer and station among `passes`, the last STATION_DAYS over the station, which the
 * Passes table matches to its rows, with whether GIBS has their pixels and a replay of each.
 */
export function useRecordedOverpasses(passes: Ref<readonly { name: string; groundStationName?: string }[]>) {
  const { sats } = useController();
  const replay = useOverpassReplay();

  /** The pairs to ask about, as a key that changes only when they do. */
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

  const recorded = shallowRef<RecordedOverpass[]>([]);
  /** GIBS's answer for each day granule of an overpass, by overpass. */
  const pixels = reactive(new Map<RecordedOverpass, boolean[]>());
  let asked = new Set<RecordedOverpass>();
  let asking: AbortController | undefined;

  watch(
    pairsKey,
    () => {
      asking?.abort();
      const controller = new AbortController();
      asking = controller;
      recorded.value = [];
      pixels.clear();
      asked = new Set();
      for (const { satellite, station, layer, latitude, longitude } of pairs.value.values()) {
        void stationOverpasses(layer, { latitude, longitude }, controller.signal).then((overpasses) => {
          if (controller.signal.aborted || overpasses === undefined) return;
          const entries = overpasses.map((overpass) => ({ satellite, station, layer, overpass, day: isDayOverpass(overpass) }));
          recorded.value = [...recorded.value, ...entries];
        });
      }
    },
    { immediate: true },
  );
  onScopeDispose(() => asking?.abort());

  /** What the overpass shows; asks GIBS the first time it is wanted. */
  function imageryOf(entry: RecordedOverpass): PassImagery {
    const signal = asking?.signal;
    if (entry.day && entry.layer.provider !== "cmr" && !asked.has(entry) && signal !== undefined) {
      asked.add(entry);
      const granules = entry.overpass.granules.filter((granule) => granule.day);
      void Promise.all(granules.map((granule) => hasPixels(entry.layer, granule))).then((answers) => {
        if (!signal.aborted) pixels.set(entry, answers);
      });
    }
    return passImagery(entry, pixels.get(entry));
  }

  /**
   * Replays a pass over its station, as every pass is: the clock from five minutes before it
   * at 30×, the camera above the station. One CMR recorded by day has its granules on too,
   * and the replay bar steps through the satellite's others there; any other takes a
   * replay's granules off, as they are of another pass.
   */
  function replayPass(pass: { start: number; groundStationName?: string }, entry: RecordedOverpass | undefined): void {
    const station = sats.groundStations.find((gs) => gs.name === (entry?.station ?? pass.groundStationName));
    if (station === undefined) return;
    const point = { latitude: station.position.latitude, longitude: station.position.longitude };
    if (entry === undefined || !entry.day) {
      replay.stop();
      replay.jump(stationReplay(pass, point), false);
      return;
    }
    const overpasses = recorded.value
      .filter((other) => other.day && other.satellite === entry.satellite && other.station === entry.station && other.layer.token === entry.layer.token)
      .map((other) => other.overpass)
      .toSorted((a, b) => a.start - b.start);
    replay.start(entry.layer, entry.satellite, stationReplay(entry.overpass, point), { name: entry.station, point, overpasses });
  }

  return { recorded, imageryOf, replayPass };
}
