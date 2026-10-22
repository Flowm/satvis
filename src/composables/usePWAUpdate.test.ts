import { afterEach, expect, test, vi } from "vitest";

const { registerSW } = vi.hoisted(() => ({ registerSW: vi.fn() }));
vi.mock("virtual:pwa-register", () => ({ registerSW }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a failed periodic update check is caught, not an unhandled rejection", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("caches", { delete: () => Promise.resolve(true) });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const failure = new DOMException("Failed to update a ServiceWorker", "InvalidStateError");
  const update = vi.fn(() => Promise.reject(failure));
  registerSW.mockImplementation((options: { onRegistered: (registration: unknown) => void }) => {
    options.onRegistered({ update });
    return () => Promise.resolve();
  });

  const { usePWAUpdate } = await import("./usePWAUpdate");
  usePWAUpdate({ updateInterval: 60 });
  await vi.advanceTimersByTimeAsync(60_000);

  expect(update).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith("PWA: Update check failed:", failure);
});
