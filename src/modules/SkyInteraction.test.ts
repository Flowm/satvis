import type { Scene } from "@cesium/engine";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { SatelliteManager } from "./SatelliteManager";
import { SkyInteraction } from "./SkyInteraction";
import type { SkyView } from "./SkyView";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SkyInteraction", () => {
  test("stop turns off a compass switched on during the entry flight", async () => {
    vi.useFakeTimers();
    const listeners = new Set<(event: unknown) => void>();
    vi.stubGlobal("DeviceOrientationEvent", class {});
    vi.stubGlobal("window", {
      addEventListener: (_type: string, listener: (event: unknown) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: unknown) => void) => listeners.delete(listener),
    });
    vi.stubGlobal("screen", { orientation: { angle: 0 } });
    const skyView = { fovy: 75, look: vi.fn() } as unknown as SkyView;
    const interaction = new SkyInteraction({ scene: {} as Scene, skyView, sats: {} as SatelliteManager });

    const outcome = interaction.aiming.enable();
    listeners.forEach((listener) => listener({ type: "deviceorientationabsolute", alpha: 100, beta: 60, gamma: -5, absolute: true }));
    await vi.advanceTimersByTimeAsync(1200);
    expect(await outcome).toBe("aiming");

    // Interaction starts on landing, so this `stop` comes before any `start`.
    interaction.stop();
    expect(interaction.aiming.active).toBe(false);
    expect(listeners.size).toBe(0);
  });
});
