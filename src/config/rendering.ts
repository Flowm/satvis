// Rendering quality choices that are neither a view mode nor a layer.

/**
 * Frame cost is near linear in samples (M4 Pro, 2552x3152, empty globe: 15.1 ms at 1x,
 * 22.1 at 2x, 28.8 at 4x). No 8x: WebGL2 caps `maximumSamples` at 4 on ANGLE/Metal,
 * and Cesium clamps silently.
 */
export const MSAA_RATES = ["off", "2", "4"] as const;

export type MsaaRate = (typeof MSAA_RATES)[number];

/** `1` is how Cesium spells "off". */
export function msaaSamplesFor(rate: string): number {
  return rate === "off" ? 1 : Number(rate);
}

/** Device pixels per CSS pixel at which the globe's limb is already oversampled. */
export const HIDPI_THRESHOLD = 2;

/**
 * MSAA changes only the globe's limb: labels (sdf) and polylines are byte-identical
 * at 4x and off. That limb is 0.044% of the frame at ratio 2, where 4x costs 13.3 ms
 * of 30.4 ms (74 satellites); at ratio 1, 2x costs 1.1 ms. Keep `pixelRatio` at
 * `native` and let MSAA give way: `1.5x + 4x` costs 18.8 ms against 17.1 ms for
 * `native + off`, and blurs labels.
 *
 * Polylines have no antialiasing of their own, so FXAA covers them (createViewer.ts).
 */
export function defaultMsaaRate(devicePixelRatio: number): MsaaRate {
  return devicePixelRatio >= HIDPI_THRESHOLD ? "off" : "2";
}

/** 1 without a `window` (vitest's node environment), which keeps antialiasing on. */
export function currentDevicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio;
}

/**
 * The ratios a `pixelratio` link may name besides `native`, in drawing-buffer pixels per
 * CSS pixel along one axis. On a ratio-2 display an empty globe costs 29.6 ms
 * at native and 9.8 ms at 1 (3.10 ms/Mpx). The top bound keeps a link from asking for a
 * drawing buffer no GPU allocates.
 */
export const PIXEL_RATIO_RANGE = [1, 4] as const;

/**
 * Below it the halfway rung saves too little to offer: 1.25 on a ratio-1.5 display
 * still draws 69% of native's pixels.
 */
export const MID_PIXEL_RATIO_FROM = 2;

/** Halfway from 1 to the display's ratio, to a quarter so its label stays short: 1.5 at 2, 2 at 3, 1.75 at 2.625. */
export function midPixelRatio(devicePixelRatio: number): number {
  return Math.min(Math.round(((1 + devicePixelRatio) / 2) * 4) / 4, PIXEL_RATIO_RANGE[1]);
}

/** The ratio a rung draws at on this display; 1 for a nonsense display ratio. */
export function pixelRatioValue(ratio: string, devicePixelRatio: number): number {
  if (!(devicePixelRatio > 0)) {
    return 1;
  }
  return ratio === "native" ? devicePixelRatio : Number(ratio);
}

/**
 * 1, halfway from a ratio of 2, then `native`, each but `native` strictly below the
 * display's ratio: the menu only offers savings. The url is not narrowed, so
 * `?pixelratio=1.5` still supersamples on ratio 1.
 */
export function pixelRatiosFor(devicePixelRatio: number): readonly string[] {
  const rungs: string[] = [];
  if (devicePixelRatio > 1) {
    rungs.push("1");
  }
  if (devicePixelRatio >= MID_PIXEL_RATIO_FROM) {
    rungs.push(String(midPixelRatio(devicePixelRatio)));
  }
  rungs.push("native");
  return rungs;
}

/** The rung the menu marks for `ratio`: the offered one drawing at the same ratio, as `native` for a link's `2` on ratio 2. */
export function offeredPixelRatio(ratio: string, devicePixelRatio: number): string | undefined {
  const value = pixelRatioValue(ratio, devicePixelRatio);
  return pixelRatiosFor(devicePixelRatio).find((rung) => pixelRatioValue(rung, devicePixelRatio) === value);
}

/** Cesium multiplies `resolutionScale` by the device ratio when `useBrowserRecommendedResolution` is false. */
export function resolutionScaleFor(ratio: string, devicePixelRatio: number): number {
  if (!(devicePixelRatio > 0)) {
    return 1;
  }
  return pixelRatioValue(ratio, devicePixelRatio) / devicePixelRatio;
}

/** The native app's choices (`Session.frameRates`): frames a second, or the screen's own rate. */
export const FRAME_RATES = ["30", "60", "max"] as const;

export type FrameRate = (typeof FRAME_RATES)[number];

/** The interval between frames a rate asks for (`FrameCap`), none for `max`. */
export function frameIntervalFor(rate: FrameRate): number | undefined {
  return rate === "max" ? undefined : 1000 / Number(rate);
}

/** The performance panel (`fps`): hidden, compact, or expanded into the frame-time graph. */
export const FPS_PANELS = ["false", "true", "graph"] as const;
/** As the url spells it (`fps`). */
export type FpsPanel = (typeof FPS_PANELS)[number];

/**
 * The benchmark panel (`bench`): hidden, open, or open with a run to start once the scene
 * has loaded, which then reads `true` again so the link does not spread (ADR 0016).
 */
export const BENCHMARK_MODES = ["false", "true", "run"] as const;
/** As the url spells it (`bench`). */
export type BenchmarkMode = (typeof BENCHMARK_MODES)[number];
