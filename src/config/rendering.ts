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
 * Drawing-buffer pixels per CSS pixel, along one axis. On a ratio-2 display an empty
 * globe costs 29.6 ms at native and 9.8 ms at 1 (3.10 ms/Mpx). The top rung is
 * `native`, not `2`, so a ratio-3 phone can still draw at its own resolution.
 */
export const PIXEL_RATIOS = ["1", "1.5", "native"] as const;

export type PixelRatio = (typeof PIXEL_RATIOS)[number];

/**
 * The fixed rungs strictly below the display's ratio, then `native`: the menu only offers
 * savings. The url is not narrowed, so `?pixelratio=1.5` still supersamples on ratio 1.
 */
export function pixelRatiosFor(devicePixelRatio: number): readonly PixelRatio[] {
  return PIXEL_RATIOS.filter((ratio) => ratio === "native" || Number(ratio) < devicePixelRatio);
}

/** Cesium multiplies `resolutionScale` by the device ratio when `useBrowserRecommendedResolution` is false. */
export function resolutionScaleFor(ratio: string, devicePixelRatio: number): number {
  if (ratio === "native" || devicePixelRatio <= 0) {
    return 1;
  }
  return Number(ratio) / devicePixelRatio;
}
