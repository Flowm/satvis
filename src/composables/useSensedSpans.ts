import { computed, type Ref, shallowRef, watch } from "vue";

import { useOverpassReplay } from "@/composables/useOverpassReplay";
import { orbitOverpasses } from "@/modules/overpassReplay";

/** How often the spans are listed afresh as the clock moves: a quarter of the day, inside the day either side they cover. */
const BUCKET_MS = 6 * 60 * 60 * 1000;

/**
 * When the granule layer on has granules by day, a day either side of the clock, which the
 * timeline shades (ADR 0023): the clock outside them shows nothing new.
 */
export function useSensedSpans(time: () => number): Ref<readonly { start: number; end: number }[]> {
  const { layerOn } = useOverpassReplay();
  const spans = shallowRef<readonly { start: number; end: number }[]>([]);
  const bucket = computed(() => Math.floor(time() / BUCKET_MS));
  watch(
    [() => layerOn.value?.layer.token, bucket],
    ([token, at], previous, onCleanup) => {
      // The clock moving on keeps the spans until the new ones come: scrubbing past the buckets emptied the timeline.
      if (token !== previous?.[0]) spans.value = [];
      const layer = layerOn.value?.layer;
      if (token === undefined || layer === undefined) return;
      const asking = new AbortController();
      onCleanup(() => asking.abort());
      void orbitOverpasses(layer, (at + 0.5) * BUCKET_MS, asking.signal).then((overpasses) => {
        if (!asking.signal.aborted) spans.value = overpasses ?? [];
      });
    },
    { immediate: true },
  );
  return spans;
}
