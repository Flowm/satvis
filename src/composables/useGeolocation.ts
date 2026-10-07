// Not VueUse's `useGeolocation`: its `watchPosition` keeps the location indicator lit for a
// value read once. Needs a secure context, so `pnpm dev:host` over http cannot exercise it.

import { readonly, type Ref, ref } from "vue";

import type { CesiumController } from "../modules/CesiumController";
import type { Observer } from "../modules/skyGeometry";

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

/** `pending` is module scope: there is one device. */
export function useGeolocation(cc: CesiumController): { pending: Readonly<Ref<boolean>>; locate: () => Promise<void> } {
  async function locate(): Promise<void> {
    if (pending.value) {
      return;
    }
    pending.value = true;
    try {
      await cc.setGroundStationFromGeolocation();
    } finally {
      pending.value = false;
    }
  }

  return { pending: readonly(pending), locate };
}
