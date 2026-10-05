// The only place the deck writes the viewer's clock. Scrubbing writes the clock directly and
// pins on release: `CesiumController.setTime` per pointer event would rebuild the window under the thumb.

import { JulianDate } from "@cesium/engine";
import { computed, onUnmounted, ref } from "vue";

import { rungFor, LADDER } from "../modules/util/clockDeck";
import { useCesiumStore } from "../stores/cesium";
import { useController } from "./useController";

// Every write here re-renders the deck, and the tick listener runs at render rate.
const READOUT_MS = 100;

/** The granularity the url records anyway. See CONTEXT.md, live vs pinned time. */
const PRESENT_TOLERANCE_MS = 60_000;

export function useViewerClock() {
  const cc = useController();
  const cesiumStore = useCesiumStore();
  const { clock, clockViewModel } = cc.viewer;

  const now = ref(JulianDate.toDate(clock.currentTime));
  const playing = ref(clock.shouldAnimate);
  const multiplier = ref(clock.multiplier);
  // Wall-clock time at the same throttle, so no second timer is needed.
  const systemNow = ref(Date.now());

  // While a finger is down the clock is written, not read, or the thumb fights the tick.
  let scrubbing = false;
  let lastRead = 0;

  const removeTickListener = clock.onTick.addEventListener(() => {
    playing.value = clock.shouldAnimate;
    multiplier.value = clock.multiplier;
    const elapsed = performance.now();
    if (elapsed - lastRead < READOUT_MS) {
      return;
    }
    lastRead = elapsed;
    systemNow.value = Date.now();
    if (scrubbing) {
      return;
    }
    now.value = JulianDate.toDate(clock.currentTime);
  });
  onUnmounted(removeTickListener);

  /** Not the same as pinned: 60× leaves the present in a second, with nothing touched. */
  const offPresent = computed(() => Math.abs(now.value.getTime() - systemNow.value) > PRESENT_TOLERANCE_MS);

  const rung = computed(() => rungFor(multiplier.value));

  function setPlaying(value: boolean): void {
    clockViewModel.shouldAnimate = value;
    playing.value = value;
    cc.viewer.scene.requestRender();
  }

  const togglePlaying = (): void => setPlaying(!playing.value);

  function setMultiplier(value: number): void {
    clockViewModel.multiplier = value;
    multiplier.value = value;
    cc.viewer.scene.requestRender();
  }

  const setRung = (index: number): void => setMultiplier(LADDER[index]!);

  function beginScrub(): void {
    scrubbing = true;
  }

  function scrubTo(date: Date): void {
    clock.currentTime = JulianDate.fromDate(date);
    now.value = date;
    cc.viewer.scene.requestRender();
  }

  /** Records the moment, which pins the clock and puts `?time=` in the url. */
  function endScrub(): void {
    scrubbing = false;
    cesiumStore.setTime(now.value.toISOString());
  }

  function cancelScrub(): void {
    scrubbing = false;
  }

  /** Back to the present and to live, which also rebuilds the window to −12 h / +7 d. */
  function goLive(): void {
    cc.setTime(new Date());
    cesiumStore.setTime(null);
    systemNow.value = Date.now();
    now.value = JulianDate.toDate(clock.currentTime);
    cc.viewer.scene.requestRender();
  }

  return {
    now,
    playing,
    multiplier,
    rung,
    offPresent,
    togglePlaying,
    setMultiplier,
    setRung,
    beginScrub,
    scrubTo,
    endScrub,
    cancelScrub,
    goLive,
  };
}

export type ViewerClock = ReturnType<typeof useViewerClock>;
