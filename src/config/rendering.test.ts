import { describe, expect, test } from "vitest";

import {
  FRAME_RATES,
  MSAA_RATES,
  PIXEL_RATIOS,
  currentDevicePixelRatio,
  defaultMsaaRate,
  msaaSamplesFor,
  pixelRatiosFor,
  resolutionScaleFor,
  targetFrameRateFor,
} from "./rendering";

describe("msaaSamplesFor", () => {
  test("off is one sample, which is how Cesium spells it", () => {
    expect(msaaSamplesFor("off")).toBe(1);
  });

  test("a rate is its own sample count", () => {
    expect(msaaSamplesFor("2")).toBe(2);
    expect(msaaSamplesFor("4")).toBe(4);
  });

  test("every offered rate maps to a usable sample count", () => {
    for (const rate of MSAA_RATES) {
      const samples = msaaSamplesFor(rate);
      expect(Number.isInteger(samples)).toBe(true);
      expect(samples).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("resolutionScaleFor", () => {
  test("native leaves Cesium's own multiplication alone", () => {
    expect(resolutionScaleFor("native", 2)).toBe(1);
    expect(resolutionScaleFor("native", 3)).toBe(1);
  });

  test("a fixed ratio divides out the display's own", () => {
    expect(resolutionScaleFor("1", 2)).toBe(0.5);
    expect(resolutionScaleFor("1.5", 2)).toBe(0.75);
    expect(resolutionScaleFor("1", 1)).toBe(1);
    expect(resolutionScaleFor("1.5", 3)).toBe(0.5);
  });

  test("asking for more than the display has supersamples rather than clamping", () => {
    expect(resolutionScaleFor("1.5", 1)).toBe(1.5);
  });

  test("a nonsense device ratio falls back to native rather than dividing by zero", () => {
    expect(resolutionScaleFor("1.5", 0)).toBe(1);
    expect(resolutionScaleFor("1.5", -1)).toBe(1);
  });

  test("every offered ratio yields a positive finite scale", () => {
    for (const ratio of PIXEL_RATIOS) {
      const scale = resolutionScaleFor(ratio, 2);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
    }
  });

  test("the ladder spans 1x to the display's own at every density", () => {
    for (const dpr of [1, 2, 3]) {
      const absolute = PIXEL_RATIOS.map((ratio) => resolutionScaleFor(ratio, dpr) * dpr);
      expect(absolute.at(0)).toBe(1);
      expect(absolute.at(-1)).toBe(dpr);
    }
  });
});

describe("pixelRatiosFor", () => {
  test("a ratio-2 display gets the three rungs the menu was designed around", () => {
    expect(pixelRatiosFor(2)).toEqual(["1", "1.5", "native"]);
  });

  test("a ratio-3 display gets the same three, with native meaning 3x", () => {
    expect(pixelRatiosFor(3)).toEqual(["1", "1.5", "native"]);
    expect(resolutionScaleFor("native", 3) * 3).toBe(3);
  });

  test("a ratio-1 display has nothing to trade, so only native is offered", () => {
    expect(pixelRatiosFor(1)).toEqual(["native"]);
  });

  test("a fractional display keeps only the rungs below it", () => {
    expect(pixelRatiosFor(1.5)).toEqual(["1", "native"]);
  });

  test("native is always offered and always last", () => {
    for (const dpr of [1, 1.5, 2, 2.625, 3]) {
      expect(pixelRatiosFor(dpr).at(-1)).toBe("native");
    }
  });

  test("no rung ever asks for more pixels than the display has", () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      for (const ratio of pixelRatiosFor(dpr)) {
        expect(resolutionScaleFor(ratio, dpr) * dpr).toBeLessThanOrEqual(dpr);
      }
    }
  });
});

describe("defaultMsaaRate", () => {
  test("a hidpi display starts with no multisampling", () => {
    expect(defaultMsaaRate(2)).toBe("off");
    expect(defaultMsaaRate(3)).toBe("off");
  });

  test("a display at or below css resolution keeps 2x, where the limb still steps", () => {
    expect(defaultMsaaRate(1)).toBe("2");
    expect(defaultMsaaRate(1.5)).toBe("2");
  });

  test("the default is always one of the rates the menu offers", () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.625, 3, 4]) {
      expect(MSAA_RATES).toContain(defaultMsaaRate(dpr));
    }
  });

  test("4x is never a default — it is only ever an explicit choice", () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      expect(defaultMsaaRate(dpr)).not.toBe("4");
    }
  });
});

describe("currentDevicePixelRatio", () => {
  // The store reads this at setup, which also runs under vitest's node environment.
  test("answers 1 with no window rather than throwing", () => {
    expect(globalThis.window).toBeUndefined();
    expect(currentDevicePixelRatio()).toBe(1);
  });

  test("the headless default keeps antialiasing on", () => {
    expect(defaultMsaaRate(currentDevicePixelRatio())).toBe("2");
  });
});

/**
 * Frames drawn a second by CesiumWidget's render loop under a cap, its arithmetic copied, on
 * a screen whose frames come 0.1 ms early and late by turns.
 */
function framesDrawn(cap: number | undefined, refreshMs: number): number {
  let lastFrameTime = 0;
  let drawn = 0;
  for (let frame = 1; frame * refreshMs <= 10_000; frame += 1) {
    const frameTime = frame * refreshMs + (frame % 2 === 0 ? 0.1 : -0.1);
    const delta = frameTime - lastFrameTime;
    if (cap === undefined) {
      drawn += 1;
    } else if (delta > 1000 / cap) {
      drawn += 1;
      lastFrameTime = frameTime - (delta % (1000 / cap));
    }
  }
  return drawn / 10;
}

describe("targetFrameRateFor", () => {
  test("max sets no cap", () => {
    expect(targetFrameRateFor("max")).toBeUndefined();
  });

  test("a cap draws its rate, within its headroom, on a 60 Hz and a 120 Hz screen", () => {
    for (const rate of FRAME_RATES.filter((capped) => capped !== "max")) {
      for (const refreshMs of [1000 / 60, 1000 / 120]) {
        const drawn = framesDrawn(targetFrameRateFor(rate), refreshMs);
        expect(drawn).toBeGreaterThanOrEqual(Math.min(Number(rate), 1000 / refreshMs) - 0.2);
        expect(drawn).toBeLessThanOrEqual(Number(rate) * 1.05);
      }
    }
  });

  test("a cap of exactly the screen's rate would have drawn half its frames", () => {
    expect(framesDrawn(60, 1000 / 60)).toBe(30);
  });
});
