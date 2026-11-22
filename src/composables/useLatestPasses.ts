import { reactive, watch } from "vue";

import { useController } from "@/composables/useController";
import { useViewerClock } from "@/composables/useViewerClock";
import type { GranuleLayer } from "@/config/instrumentImagery";
import { AFTER_OVERPASS_MS, latestGranule, type LatestGranules, REPLAY_LEAD_MS } from "@/modules/overpassReplay";
import { useCesiumStore } from "@/stores/cesium";

/** How often the newest granules are asked again while they are shown: CMR lists one every 6 minutes. */
const REFRESH_MS = 10 * 60 * 1000;

/**
 * The newest pass of each granule layer `layers` gives, by its key: the newest day granule
 * with pixels, which a card pictures and the clock goes to, as a layer's latest frame may be
 * by night or one GIBS left out. Asked again when the keys change, and every REFRESH_MS.
 */
export function useLatestPasses(layers: () => readonly { key: string; layer: GranuleLayer }[]) {
  const controller = useController();
  const cesiumStore = useCesiumStore();
  const { now } = useViewerClock();
  const latest = reactive(new Map<string, LatestGranules>());

  watch(
    () =>
      layers()
        .map(({ key }) => key)
        .join("\n"),
    (_keys, _, onCleanup) => {
      latest.clear();
      const asked = layers();
      if (asked.length === 0) return;
      const reading = new AbortController();
      const ask = () => {
        for (const { key, layer } of asked) {
          void latestGranule(layer, reading.signal).then((granules) => {
            if (granules !== undefined && !reading.signal.aborted) latest.set(key, granules);
          });
        }
      };
      ask();
      const timer = setInterval(ask, REFRESH_MS);
      onCleanup(() => {
        reading.abort();
        clearInterval(timer);
      });
    },
    { immediate: true },
  );

  /** The clock is past the newest pass, so the layer shows nothing at its time. */
  function isPastNewest(key: string): boolean {
    const granule = latest.get(key)?.newest;
    return granule !== undefined && now.value.getTime() > granule.end + AFTER_OVERPASS_MS;
  }

  /** The clock to a few minutes before the newest pictured pass, so the satellite flies onto it; pinned in the url. */
  function goToNewest(key: string): void {
    const granule = latest.get(key)?.pictured;
    if (granule === undefined) return;
    const time = granule.start - REPLAY_LEAD_MS;
    controller.setTime(time);
    cesiumStore.setTime(new Date(time).toISOString());
  }

  return { latest, isPastNewest, goToNewest };
}
