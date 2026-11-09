import { describe, expect, test } from "vitest";

import {
  MSAA_RATES,
  PIXEL_RATIO_RANGE,
  currentDevicePixelRatio,
  defaultMsaaRate,
  frameIntervalFor,
  midPixelRatio,
  msaaSamplesFor,
  offeredPixelRatio,
  pixelRatioValue,
  pixelRatiosFor,
  resolutionScaleFor,
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

  test("every ratio a link may name yields a positive finite scale", () => {
    for (const ratio of ["1", "1.3", "2", "4", "native"]) {
      const scale = resolutionScaleFor(ratio, 2);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
    }
  });

  test("the ladder spans 1x to the display's own at every density", () => {
    for (const dpr of [1, 2, 3]) {
      const absolute = ["1", "native"].map((ratio) => resolutionScaleFor(ratio, dpr) * dpr);
      expect(absolute.at(0)).toBe(1);
      expect(absolute.at(-1)).toBe(dpr);
    }
  });
});

describe("pixelRatiosFor", () => {
  test("a ratio-2 display gets 1, halfway and native, which draw at 1x, 1.5x and 2x", () => {
    expect(pixelRatiosFor(2)).toEqual(["1", "1.5", "native"]);
    expect(pixelRatiosFor(2).map((ratio) => pixelRatioValue(ratio, 2))).toEqual([1, 1.5, 2]);
  });

  test("a ratio-3 display gets 2x halfway, not 1.5x, so its pixels step 11%, 44%, 100%", () => {
    expect(pixelRatiosFor(3)).toEqual(["1", "2", "native"]);
  });

  test("an uneven ratio goes halfway to a quarter, and never past 4", () => {
    expect(midPixelRatio(2.625)).toBe(1.75);
    expect(midPixelRatio(2.75)).toBe(2);
    expect(midPixelRatio(3.5)).toBe(2.25);
    expect(midPixelRatio(6)).toBe(3.5);
    expect(midPixelRatio(9)).toBe(4);
  });

  test("every halfway rung is in the url's range", () => {
    for (let dpr = 2; dpr <= 9; dpr += 0.125) {
      const mid = Number(pixelRatiosFor(dpr).at(-2));
      expect(mid).toBeGreaterThanOrEqual(PIXEL_RATIO_RANGE[0]);
      expect(mid).toBeLessThanOrEqual(PIXEL_RATIO_RANGE[1]);
    }
  });

  test("a ratio-1 display has nothing to trade, so only native is offered", () => {
    expect(pixelRatiosFor(1)).toEqual(["native"]);
  });

  test("below a ratio of 2 halfway saves too little, and only 1 and native are offered", () => {
    expect(pixelRatiosFor(1.25)).toEqual(["1", "native"]);
    expect(pixelRatiosFor(1.5)).toEqual(["1", "native"]);
    expect(pixelRatiosFor(1.75)).toEqual(["1", "native"]);
  });

  test("native is always offered and always last", () => {
    for (const dpr of [1, 1.5, 2, 2.625, 3]) {
      expect(pixelRatiosFor(dpr).at(-1)).toBe("native");
    }
  });

  test("the rungs climb strictly, and none asks for more pixels than the display has", () => {
    for (const dpr of [1, 1.25, 1.5, 2, 2.625, 2.75, 3, 3.5, 4]) {
      const values = pixelRatiosFor(dpr).map((ratio) => pixelRatioValue(ratio, dpr));
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThan(values[i - 1]!);
      }
      expect(values.at(-1)).toBe(dpr);
    }
  });
});

describe("offeredPixelRatio", () => {
  test("a link's 2 marks native on ratio 2, where they draw the same", () => {
    expect(offeredPixelRatio("2", 2)).toBe("native");
  });

  test("a link's 1 marks native on ratio 1", () => {
    expect(offeredPixelRatio("1", 1)).toBe("native");
  });

  test("a ratio the menu does not offer marks none", () => {
    expect(offeredPixelRatio("1.5", 3)).toBeUndefined();
  });

  test("each offered rung marks itself", () => {
    for (const dpr of [1, 1.5, 2, 2.625, 3]) {
      for (const ratio of pixelRatiosFor(dpr)) {
        expect(offeredPixelRatio(ratio, dpr)).toBe(ratio);
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

describe("frameIntervalFor", () => {
  test("max sets no cap", () => {
    expect(frameIntervalFor("max")).toBeUndefined();
    expect(frameIntervalFor("60")).toBeCloseTo(1000 / 60, 9);
  });
});
