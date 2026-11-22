import { storeToRefs } from "pinia";
import { computed, type ComputedRef, effectScope, type Ref, ref, type ShallowRef, shallowRef, watch } from "vue";

import { useController } from "@/composables/useController";
import { type GranuleLayer, granuleLayerOwner } from "@/config/instrumentImagery";
import { stationLabel } from "@/modules/GroundStationEntity";
import { isDayOverpass, stationOverpasses, stationReplay } from "@/modules/overpassReplay";
import type { RecordedOverpass } from "@/modules/passImagery";
import type { ReplayCamera } from "@/modules/ReplayCamera";
import type { GroundPoint } from "@/modules/util/cmrGranules";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

/** A granule layer on the globe, and the satellite and instrument whose it is. */
interface GranuleLayerOn {
  layer: GranuleLayer;
  satellite: string;
  instrument: string;
}

/** An overpass replay: the newest granule layer on, over the station the url names, and the overpasses its bar steps through. */
interface OverpassReplay extends GranuleLayerOn {
  station: { name: string; point: GroundPoint };
  /**
   * By start: the recorded overpasses by day of the Passes table the replay was started
   * from, a station's of each satellite or a satellite's over each station (replaySteps);
   * opened from a link, its layer's over its station.
   */
  steps: RecordedOverpass[];
}

/** A layer's overpasses by day over a station, as fetched for a replay opened from a link. */
interface Listed {
  key: string;
  steps: RecordedOverpass[];
}

/** Shared by every caller, as each would otherwise read the catalog and ask CMR for itself. */
let shared:
  | {
      layerOn: ComputedRef<GranuleLayerOn | undefined>;
      replay: ComputedRef<OverpassReplay | undefined>;
      steps: ShallowRef<RecordedOverpass[] | undefined>;
      camera: Ref<ReplayCamera>;
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

  /** Where the station named is, as the passes name it. */
  function pointOf(station: string): GroundPoint | undefined {
    const found = cc.sats.groundStations.find((gs) => gs.name === station);
    return found && { latitude: found.position.latitude, longitude: found.position.longitude };
  }

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
    const steps = shallowRef<RecordedOverpass[]>();
    const camera = ref<ReplayCamera>("broadcast");
    /** Whether the steps a replay was started with hold the layer and station on. */
    const stepped = computed(() => steps.value?.some((entry) => entry.layer.token === layerOn.value?.layer.token && entry.station === replayStation.value) ?? false);

    const key = computed(() => layerOn.value && point.value && `${layerOn.value.layer.token}|${replayStation.value}|${point.value.latitude}|${point.value.longitude}`);
    const listed = shallowRef<Listed>();
    let asking: AbortController | undefined;
    watch(
      key,
      (now) => {
        asking?.abort();
        if (now === undefined || stepped.value || listed.value?.key === now) return;
        const { layer, satellite } = layerOn.value!;
        const station = replayStation.value;
        const controller = new AbortController();
        asking = controller;
        void stationOverpasses(layer, point.value!, controller.signal).then((overpasses) => {
          if (controller.signal.aborted) return;
          const entries = (overpasses ?? []).filter(isDayOverpass).map((overpass) => ({ pair: now, satellite, station, layer, overpass, day: true }));
          listed.value = { key: now, steps: entries };
        });
      },
      { immediate: true },
    );
    watch(layerOn, (on) => {
      if (on === undefined && replayStation.value !== "") {
        replayStation.value = "";
        steps.value = undefined;
        cc.releaseReplayCamera();
      }
    });
    const replay = computed((): OverpassReplay | undefined => {
      const on = layerOn.value;
      if (on === undefined || point.value === undefined || replayStation.value === "") return undefined;
      const station = { name: replayStation.value, point: point.value };
      if (stepped.value) return { ...on, station, steps: steps.value! };
      if (listed.value?.key === key.value) return { ...on, station, steps: listed.value!.steps };
      return undefined;
    });
    return { layerOn, replay, steps, camera };
  })!;

  /** Turns `step`'s satellite and layer on in place of the replay's, and replays it at `multiplier`. */
  function replayStep(to: RecordedOverpass, multiplier: number): void {
    const before = shared!.layerOn.value?.layer.token;
    if (cesiumStore.replayStation !== "" && before !== undefined && before !== to.layer.token) {
      cesiumStore.toggleInstrumentImagery(before, false);
    }
    satStore.activateSatellite(to.satellite, cc.sats.catalog);
    cesiumStore.toggleInstrumentImagery(to.layer.token, true);
    cesiumStore.replayStation = to.station;
    const point = pointOf(to.station);
    if (point !== undefined) cc.replay({ ...stationReplay(to.overpass, point, to.satellite), multiplier }, shared!.camera.value);
  }

  /** Starts a replay of `step`, in place of the one on, its bar stepping through `steps` (replaySteps). */
  function start(first: RecordedOverpass, steps: RecordedOverpass[]): void {
    shared!.steps.value = steps;
    replayStep(first, 30);
  }

  /** Goes to another of the replay's steps, at the speed the clock runs. */
  function step(to: RecordedOverpass): void {
    replayStep(to, cc.viewer.clock.multiplier);
  }

  /** Watches the replay on from `camera`, and any replay after. */
  function watchFrom(camera: ReplayCamera): void {
    shared!.camera.value = camera;
    const on = shared!.replay.value;
    if (on !== undefined) cc.aimReplay({ satellite: on.satellite, centre: on.station.point }, camera);
  }

  /** Takes the replay's layer off, and no other, and leaves the camera where it is; the clock is the caller's to put back. */
  function stop(): void {
    const token = shared!.replay.value?.layer.token;
    if (token !== undefined) cesiumStore.toggleInstrumentImagery(token, false);
    cesiumStore.replayStation = "";
    shared!.steps.value = undefined;
    cc.releaseReplayCamera();
  }

  return { layerOn: shared.layerOn, replay: shared.replay, camera: shared.camera, start, step, watchFrom, stop };
}
