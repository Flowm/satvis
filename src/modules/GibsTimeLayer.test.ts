import { Clock, JulianDate, type TimeIntervalCollection } from "@cesium/engine";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ImageryContext } from "./CesiumLayerProviders";
import { createGibsTimeLayer, type GibsTimeLayerOptions } from "./GibsTimeLayer";

const GOES: GibsTimeLayerOptions = { layer: "GOES-East_ABI_Band13_Clean_Infrared", maximumLevel: 6, format: "png", daily: false };
const DOMAIN = "2026-10-04T20:00:00Z/2026-10-04T23:50:00Z/PT10M,2026-10-05T01:00:00Z/2026-10-05T11:20:00Z/PT10M";

const domainResponse = (domain: string) => new Response(`<Domains><DimensionDomain><Domain>${domain}</Domain></DimensionDomain></Domains>`);

function harness(iso: string) {
  const clock = new Clock({ currentTime: JulianDate.fromIso8601(iso), shouldAnimate: false });
  const lifetime = new AbortController();
  const requestRender = vi.fn();
  const context: ImageryContext = { clock, requestRender, signal: lifetime.signal };
  return {
    clock,
    context,
    requestRender,
    dispose: () => lifetime.abort(),
    setTime(next: string) {
      clock.currentTime = JulianDate.fromIso8601(next);
      clock.onTick.raiseEvent(clock);
    },
  };
}

const frameAt = (times: TimeIntervalCollection, clock: Clock) => (times.findDataForIntervalContainingDate(clock.currentTime) as { Time: string }).Time;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => domainResponse(DOMAIN));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createGibsTimeLayer", () => {
  test("asks GIBS for the frame at the clock, rounded down to one it has", async () => {
    const { clock, context } = harness("2026-10-05T09:47:00Z");
    const layer = await createGibsTimeLayer(GOES, context);
    expect(frameAt(layer.times, clock)).toBe("2026-10-05T09:40:00Z");
    expect(fetchMock.mock.calls[0]![0]).toContain("/GOES-East_ABI_Band13_Clean_Infrared/default/GoogleMapsCompatible_Level6/all/all.xml");
  });

  test("follows the clock across intervals without a rebuild inside the window", async () => {
    const { clock, context, setTime } = harness("2026-10-05T09:47:00Z");
    const layer = await createGibsTimeLayer(GOES, context);
    const times = layer.times;
    setTime("2026-10-05T10:15:00Z");
    expect(layer.times).toBe(times);
    expect(frameAt(layer.times, clock)).toBe("2026-10-05T10:10:00Z");
    // Cesium swaps tiles off its own clock, which has to be where the viewer's is.
    expect(JulianDate.equals(layer.clock.currentTime, clock.currentTime)).toBe(true);
  });

  test("rebuilds the window once the clock leaves it, and asks for a frame", async () => {
    const { clock, context, setTime, requestRender } = harness("2026-10-05T09:47:00Z");
    const layer = await createGibsTimeLayer(GOES, context);
    const times = layer.times;
    setTime("2026-10-04T21:05:00Z");
    expect(layer.times).not.toBe(times);
    expect(frameAt(layer.times, clock)).toBe("2026-10-04T21:00:00Z");
    expect(requestRender).toHaveBeenCalled();
  });

  test("does not rebuild for a clock far past the latest frame, which would only reload it", async () => {
    const { context, setTime } = harness("2026-10-05T11:49:00Z");
    const layer = await createGibsTimeLayer(GOES, context);
    const times = layer.times;
    setTime("2026-10-07T00:00:00Z");
    expect(layer.times).toBe(times);
  });

  test("refetches the domain while the clock is past the latest frame, and shows a newer one", async () => {
    const { clock, context, setTime } = harness("2026-10-05T11:49:00Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const layer = await createGibsTimeLayer(GOES, context);
    fetchMock.mockResolvedValueOnce(domainResponse("2026-10-05T01:00:00Z/2026-10-05T11:40:00Z/PT10M"));

    now.mockReturnValue(29 * 60 * 1000);
    setTime("2026-10-05T11:50:00Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(30 * 60 * 1000);
    setTime("2026-10-05T11:51:00Z");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(frameAt(layer.times, clock)).toBe("2026-10-05T11:40:00Z"));
  });

  test("falls back to GIBS's latest frame when the domain cannot be fetched", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { context } = harness("2026-10-05T09:47:00Z");
    const layer = await createGibsTimeLayer(GOES, context);
    expect(layer.dimensions).toEqual({ Time: "default" });
  });

  test("leaves no listener behind when removed while its domain was still loading", async () => {
    const { clock, context, dispose } = harness("2026-10-05T09:47:00Z");
    const before = clock.onTick.numberOfListeners;
    const pending = createGibsTimeLayer(GOES, context);
    dispose();
    await pending;
    expect(clock.onTick.numberOfListeners).toBe(before);
  });

  test("stops listening to the clock once disposed", async () => {
    const { clock, context, dispose } = harness("2026-10-05T09:47:00Z");
    const before = clock.onTick.numberOfListeners;
    await createGibsTimeLayer(GOES, context);
    expect(clock.onTick.numberOfListeners).toBe(before + 1);
    dispose();
    expect(clock.onTick.numberOfListeners).toBe(before);
  });
});
