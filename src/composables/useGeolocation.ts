// Not VueUse's `useGeolocation`: its `watchPosition` keeps the location indicator lit for a
// value read once. Needs a secure context, so `pnpm dev:host` over http cannot exercise it.

import { readonly, type Ref, ref } from "vue";

import type { Observer } from "../modules/skyGeometry";
import { useSatStore } from "../stores/sat";
import { useToastProxy } from "./useToastProxy";

/** A cold fix takes this long; shorter turns a slow success into a failure. */
const TIMEOUT_MS = 10_000;

/** Undefined when the user declines, the fix fails, or it times out. */
export async function currentPosition(): Promise<Observer | undefined> {
  if (!navigator.geolocation) {
    return undefined;
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude }),
      (error) => {
        console.warn(`Geolocation unavailable: ${error.message}`);
        resolve(undefined);
      },
      { timeout: TIMEOUT_MS },
    );
  });
}

const pending = ref(false);

/**
 * The Geolocation station where the device is, and with `observe` the sky view's
 * observer there (`placeGeolocation`, `observeGeolocation`). Whether a fix came back.
 */
async function placeStation({ observe = false }: { observe?: boolean } = {}): Promise<boolean> {
  const fix = await currentPosition();
  if (!fix) {
    useToastProxy().add({
      title: "Location unavailable",
      description: "No position came back. Check this site's location permission, and note that geolocation needs a secure context.",
      color: "warning",
    });
    return false;
  }
  const satStore = useSatStore();
  if (observe) {
    satStore.observeGeolocation(fix.lat, fix.lon);
  } else {
    satStore.placeGeolocation(fix.lat, fix.lon);
  }
  return true;
}

/** `pending` is module scope: there is one device. */
export function useGeolocation(): { pending: Readonly<Ref<boolean>>; locate: (options?: { observe?: boolean }) => Promise<boolean> } {
  /** Whether a fix came back; false while one is already pending. */
  async function locate(options?: { observe?: boolean }): Promise<boolean> {
    if (pending.value) {
      return false;
    }
    pending.value = true;
    try {
      return await placeStation(options);
    } finally {
      pending.value = false;
    }
  }

  return { pending: readonly(pending), locate };
}
