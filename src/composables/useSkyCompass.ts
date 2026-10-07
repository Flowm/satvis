// Whether the sky view aims by the device's compass. Module scope: the View menu toggle and
// the HUD note live in different subtrees. `no-heading` is a refusal (ADR 0004).

import { readonly, type Ref, ref } from "vue";

import type { CesiumController } from "../modules/CesiumController";
import type { CompassOutcome } from "../modules/DeviceAim";
import { useToastProxy } from "./useToastProxy";

/** The sensor needs a secure context. */
export const compassAvailable = (): boolean => typeof DeviceOrientationEvent !== "undefined" && window.isSecureContext;

const active = ref(false);
const pending = ref(false);

const FAILURES: Record<string, string> = {
  unsupported: "This browser does not report device orientation.",
  denied: "Motion and orientation access was declined. It can be re-enabled in the browser's site settings.",
  silent: "Orientation was granted but no readings arrived, which is usual on a device without motion sensors.",
  no_heading: "This device reports orientation but cannot tell where north is, so the sky would be aimed at an arbitrary bearing.",
};

export function useSkyCompass(cc: CesiumController): { active: Readonly<Ref<boolean>>; pending: Readonly<Ref<boolean>>; toggle: () => Promise<void> } {
  // A drag or closing the view also stops the compass. The callback is a single slot,
  // so registering it on every call is harmless.
  cc.skyInteraction.onOrientationStop(() => {
    active.value = false;
  });

  async function toggle(): Promise<void> {
    const { skyInteraction } = cc;
    if (active.value) {
      skyInteraction.disableDeviceOrientation();
      active.value = false;
      return;
    }
    if (pending.value) {
      return;
    }

    // iOS prompts for permission, and every platform answers a sensor probe first.
    pending.value = true;
    let outcome: CompassOutcome;
    try {
      outcome = await skyInteraction.enableDeviceOrientation();
    } finally {
      pending.value = false;
    }
    const aiming = outcome === "aiming" || outcome === "aiming-uncalibrated";
    active.value = aiming;

    if (aiming) {
      // Every enable says how to turn it off. iOS knows north only after the phone has been flat once.
      const calibration = outcome === "aiming-uncalibrated" ? "Hold the phone flat for a moment to set north. " : "";
      useToastProxy().add({
        title: "Aiming by compass",
        description: `${calibration}Drag at any time to turn the compass off.`,
        color: "info",
      });
      return;
    }
    if (outcome === "taken-back") {
      // The user dragged during the probe; nothing failed.
      return;
    }
    useToastProxy().add({
      title: "Compass aiming unavailable",
      description: FAILURES[outcome.replace("-", "_")] ?? "The device's orientation is not usable for aiming.",
      color: "warning",
    });
  }

  return { active: readonly(active), pending: readonly(pending), toggle };
}
