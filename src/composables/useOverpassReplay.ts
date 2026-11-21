import { useController } from "@/composables/useController";
import type { GranuleLayer } from "@/config/instrumentImagery";
import type { ReplayPlan } from "@/modules/overpassReplay";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

/**
 * Starts an overpass replay (ADR 0023): the satellite on, its granule layer on, and the
 * clock and camera as `plan` says. All of it is in the url, so a replay is a link.
 */
export function useOverpassReplay() {
  const cc = useController();
  const satStore = useSatStore();
  const cesiumStore = useCesiumStore();
  return (layer: GranuleLayer, satellite: string, plan: ReplayPlan): void => {
    satStore.activateSatellite(satellite, cc.sats.catalog);
    cesiumStore.toggleInstrumentImagery(layer.token, true);
    cc.replay(plan);
  };
}
