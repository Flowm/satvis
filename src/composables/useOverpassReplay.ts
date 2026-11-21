import { storeToRefs } from "pinia";
import { computed, type ComputedRef, effectScope, shallowRef, watch } from "vue";

import { useController } from "@/composables/useController";
import { type GranuleLayer, granuleLayerOwner } from "@/config/instrumentImagery";
import type { ReplayPlan } from "@/modules/overpassReplay";
import type { GroundPoint, Overpass } from "@/modules/util/cmrGranules";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

/** The station a replay was started from, whose overpasses it steps through. */
export interface ReplayStation {
  name: string;
  point: GroundPoint;
  /** Oldest first. */
  overpasses: Overpass[];
}

/** A granule layer on the globe, and the satellite and instrument whose it is. */
export interface GranuleLayerOn {
  layer: GranuleLayer;
  satellite: string;
  instrument: string;
}

/** A station's overpass replay on: its layer, still on, and the station it steps through. */
export interface StationReplay extends GranuleLayerOn {
  station: ReplayStation;
}

/** The replay started last, which the url does not say: a link opens its layer alone. */
const started = shallowRef<{ token: string; satellite: string; station: ReplayStation }>();

/** Shared by every caller, as each would otherwise read the catalog for itself. */
let shared: { layerOn: ComputedRef<GranuleLayerOn | undefined>; replay: ComputedRef<StationReplay | undefined> } | undefined;

/**
 * Overpass replay (ADR 0023): the satellite on, its granule layer on, and the clock and
 * camera as a plan says. All of it but the station is in the url, so a replay is a link. A
 * replay lasts while its layer is on, wherever the layer is taken off.
 */
export function useOverpassReplay() {
  const cc = useController();
  const satStore = useSatStore();
  const cesiumStore = useCesiumStore();

  shared ??= effectScope(true).run(() => {
    const { catalogRevision } = storeToRefs(satStore);
    // The newest granule layer on, as the timeline shades it.
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
    const replay = computed((): StationReplay | undefined => {
      const at = started.value;
      if (at === undefined) return undefined;
      void catalogRevision.value;
      const owner = granuleLayerOwner(cc.sats.catalog.entries, at.token);
      return owner && { layer: owner.layer, satellite: at.satellite, instrument: owner.instrument, station: at.station };
    });
    watch(
      () => started.value !== undefined && !cesiumStore.instrumentImagery.includes(started.value.token),
      (off) => {
        if (off) started.value = undefined;
      },
    );
    return { layerOn, replay };
  })!;

  /** Starts a replay over a station, in place of the one on. */
  function start(layer: GranuleLayer, satellite: string, plan: ReplayPlan, station: ReplayStation): void {
    const before = started.value?.token;
    if (before !== undefined && before !== layer.token) {
      cesiumStore.toggleInstrumentImagery(before, false);
    }
    started.value = { token: layer.token, satellite, station };
    satStore.activateSatellite(satellite, cc.sats.catalog);
    cesiumStore.toggleInstrumentImagery(layer.token, true);
    cc.replay(plan);
  }

  /** Moves the clock and camera to `plan`, at the speed the clock runs unless `keepSpeed` is false. */
  function jump(plan: ReplayPlan, keepSpeed = true): void {
    cc.replay(keepSpeed ? { ...plan, multiplier: cc.viewer.clock.multiplier } : plan);
  }

  /** Takes the replay's layer off, and no other; the clock is the caller's to put back. */
  function stop(): void {
    const token = started.value?.token;
    if (token !== undefined) {
      cesiumStore.toggleInstrumentImagery(token, false);
    }
    started.value = undefined;
  }

  return { layerOn: shared.layerOn, replay: shared.replay, start, jump, stop };
}
