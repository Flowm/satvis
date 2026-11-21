import { storeToRefs } from "pinia";
import { computed, shallowRef } from "vue";

import { useController } from "@/composables/useController";
import { type GranuleLayer, isGranuleLayer, readImageryList } from "@/config/instrumentImagery";
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

/** The replay on: its layer, the satellite whose it is, and the station it was started from. */
export interface ActiveReplay {
  layer: GranuleLayer;
  satellite: string;
  instrument: string;
  station: ReplayStation | undefined;
}

/** Where the replay on was started, which the url does not say: a link opens one from its satellite. */
const started = shallowRef<{ token: string; satellite: string; station: ReplayStation | undefined }>();

/**
 * Overpass replay (ADR 0023): the satellite on, its granule layer on, and the clock and
 * camera as a plan says. All of it but the station is in the url, so a replay is a link.
 * One replay is on at a time: the newest granule layer on the globe.
 */
export function useOverpassReplay() {
  const cc = useController();
  const satStore = useSatStore();
  const cesiumStore = useCesiumStore();
  const { catalogRevision } = storeToRefs(satStore);

  const active = computed((): ActiveReplay | undefined => {
    void catalogRevision.value;
    for (const token of cesiumStore.instrumentImagery.toReversed()) {
      for (const entry of cc.sats.catalog.entries) {
        const found = readImageryList(entry.metadata.imagery).find(({ drawn, merged }) => !merged && drawn?.token === token);
        if (found !== undefined && isGranuleLayer(found.drawn)) {
          const station = started.value?.token === token && started.value.satellite === entry.name ? started.value.station : undefined;
          return { layer: found.drawn, satellite: entry.name, instrument: found.instrument, station };
        }
      }
    }
    return undefined;
  });

  /** Starts a replay, in place of the one on. */
  function start(layer: GranuleLayer, satellite: string, plan: ReplayPlan, station?: ReplayStation): void {
    const before = active.value?.layer.token;
    if (before !== undefined && before !== layer.token) {
      cesiumStore.toggleInstrumentImagery(before, false);
    }
    started.value = { token: layer.token, satellite, station };
    satStore.activateSatellite(satellite, cc.sats.catalog);
    cesiumStore.toggleInstrumentImagery(layer.token, true);
    cc.replay(plan);
  }

  /** Moves the replay on to `plan`, at the speed the clock runs. */
  function jump(plan: ReplayPlan): void {
    cc.replay({ ...plan, multiplier: cc.viewer.clock.multiplier });
  }

  /** Takes the replay's layer off; the clock is the caller's to put back. */
  function stop(): void {
    const token = active.value?.layer.token;
    if (token !== undefined) {
      cesiumStore.toggleInstrumentImagery(token, false);
    }
    started.value = undefined;
  }

  return { active, start, jump, stop };
}
