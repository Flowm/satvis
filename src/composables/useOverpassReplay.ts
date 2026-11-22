import { storeToRefs } from "pinia";
import { computed, type ComputedRef, effectScope, type ShallowRef, shallowRef, watch } from "vue";

import { useController } from "@/composables/useController";
import { type GranuleLayer, granuleLayerOwner } from "@/config/instrumentImagery";
import { stationLabel } from "@/modules/GroundStationEntity";
import { isDayOverpass, type ReplayPlan, stationOverpasses } from "@/modules/overpassReplay";
import type { GroundPoint, Overpass } from "@/modules/util/cmrGranules";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

/** The station a replay steps through the overpasses of. */
interface ReplayStation {
  name: string;
  point: GroundPoint;
  /** By day, oldest first. */
  overpasses: Overpass[];
}

/** A granule layer on the globe, and the satellite and instrument whose it is. */
interface GranuleLayerOn {
  layer: GranuleLayer;
  satellite: string;
  instrument: string;
}

/** A station's overpass replay: the newest granule layer on, over the station the url names. */
interface StationReplay extends GranuleLayerOn {
  station: ReplayStation;
}

/** A layer's overpasses over a station, as fetched or as the Passes table had them. */
interface Listed {
  key: string;
  overpasses: Overpass[];
}

/** Shared by every caller, as each would otherwise read the catalog and ask CMR for itself. */
let shared:
  | {
      layerOn: ComputedRef<GranuleLayerOn | undefined>;
      replay: ComputedRef<StationReplay | undefined>;
      key: ComputedRef<string | undefined>;
      listed: ShallowRef<Listed | undefined>;
    }
  | undefined;

/**
 * Overpass replay (ADR 0023): the satellite on, its granule layer on, the station in the
 * url, and the clock and camera as a plan says, so a replay is a link. It lasts while its
 * layer is on, wherever the layer is taken off.
 */
export function useOverpassReplay() {
  const cc = useController();
  const satStore = useSatStore();
  const cesiumStore = useCesiumStore();

  shared ??= effectScope(true).run(() => {
    const { catalogRevision, groundStations } = storeToRefs(satStore);
    const { replayStation } = storeToRefs(cesiumStore);
    const layerOn = computed((): GranuleLayerOn | undefined => {
      void catalogRevision.value;
      for (const token of cesiumStore.instrumentImagery.toReversed()) {
        const owner = granuleLayerOwner(cc.sats.catalog.entries, token);
        if (owner !== undefined) {
          return { layer: owner.layer, satellite: owner.entry.name, instrument: owner.instrument };
        }
      }
      return undefined;
    });
    const point = computed((): GroundPoint | undefined => {
      const station = groundStations.value.find((gs) => stationLabel(gs.name, gs.lat, gs.lon) === replayStation.value);
      return station && { latitude: station.lat, longitude: station.lon };
    });
    const key = computed(() => layerOn.value && point.value && `${layerOn.value.layer.token}|${replayStation.value}|${point.value.latitude}|${point.value.longitude}`);
    const listed = shallowRef<Listed>();
    let asking: AbortController | undefined;
    watch(
      key,
      (now) => {
        asking?.abort();
        if (now === undefined || listed.value?.key === now) return;
        const controller = new AbortController();
        asking = controller;
        void stationOverpasses(layerOn.value!.layer, point.value!, controller.signal).then((overpasses) => {
          if (!controller.signal.aborted) listed.value = { key: now, overpasses: (overpasses ?? []).filter(isDayOverpass) };
        });
      },
      { immediate: true },
    );
    watch(layerOn, (on) => {
      if (on === undefined) replayStation.value = "";
    });
    const replay = computed((): StationReplay | undefined => {
      const on = layerOn.value;
      if (on === undefined || point.value === undefined || listed.value?.key !== key.value) return undefined;
      return { ...on, station: { name: replayStation.value, point: point.value, overpasses: listed.value!.overpasses } };
    });
    return { layerOn, replay, key, listed };
  })!;

  /** Starts a replay over the station named `station`, in place of the one on; `overpasses` are the layer's there by day, which spares asking CMR. */
  function start(layer: GranuleLayer, satellite: string, plan: ReplayPlan, station: string, overpasses: Overpass[]): void {
    const before = shared!.layerOn.value?.layer.token;
    if (cesiumStore.replayStation !== "" && before !== undefined && before !== layer.token) {
      cesiumStore.toggleInstrumentImagery(before, false);
    }
    satStore.activateSatellite(satellite, cc.sats.catalog);
    cesiumStore.toggleInstrumentImagery(layer.token, true);
    cesiumStore.replayStation = station;
    const key = shared!.key.value;
    if (key !== undefined) shared!.listed.value = { key, overpasses };
    cc.replay(plan);
  }

  /** Moves the clock and camera to `plan`, at the speed the clock runs. */
  function jump(plan: ReplayPlan): void {
    cc.replay({ ...plan, multiplier: cc.viewer.clock.multiplier });
  }

  /** Takes the replay's layer off, and no other; the clock is the caller's to put back. */
  function stop(): void {
    const token = shared!.replay.value?.layer.token;
    if (token !== undefined) cesiumStore.toggleInstrumentImagery(token, false);
    cesiumStore.replayStation = "";
  }

  return { layerOn: shared.layerOn, replay: shared.replay, start, jump, stop };
}
