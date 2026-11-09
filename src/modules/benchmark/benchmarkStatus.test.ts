import { describe, expect, it } from "vitest";

import { formatDuration, shownDrift, statusLine } from "./benchmarkStatus";

describe("statusLine", () => {
  it("reads a run's plan, its progress and its end", () => {
    expect(statusLine({ phase: "idle", kind: "scenes", index: 0, total: 10, remainingMs: 120_000 })).toBe("10 scenes · ≈ 2 min");
    expect(statusLine({ phase: "measuring", kind: "scenes", index: 3, total: 7, remainingMs: 50_000 })).toBe("4 of 7 · Measuring · 50 s left");
    expect(statusLine({ phase: "loading", kind: "sweep", index: 0, total: 42, remainingMs: 300_000 })).toBe("1 of 42 · Building · 5 min left");
    expect(statusLine({ phase: "done", kind: "sweep", index: 0, total: 42, remainingMs: 0, driftPct: 1.26 })).toBe("Done · drift +1.3 %");
    expect(statusLine({ phase: "cancelled", kind: "scenes", index: 0, total: 7, remainingMs: 0, measured: 3 })).toBe("Cancelled · 3 of 7");
  });

  it("switches to minutes at a minute and a half", () => {
    expect(formatDuration(89_400)).toBe("89 s");
    expect(formatDuration(90_000)).toBe("2 min");
    expect(formatDuration(-1)).toBe("0 s");
  });
});

describe("shownDrift", () => {
  // A light step's few percent are noise: 0.3 ms read -16 % on the iPad.
  it("shows nothing under a millisecond apart", () => {
    expect(shownDrift(0.3, 0.25)).toBeNull();
    expect(shownDrift(10, 10.9)).toBeNull();
  });

  it("reads slower as positive", () => {
    expect(shownDrift(10, 11.5)).toBeCloseTo(15, 9);
    expect(shownDrift(12, 10.9)).toBeCloseTo(-9.1667, 3);
  });

  it("needs a first step with time to compare", () => {
    expect(shownDrift(0, 5)).toBeNull();
    expect(shownDrift(null, 4)).toBeNull();
  });
});
