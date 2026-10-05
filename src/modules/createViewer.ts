// The only module that constructs a Viewer; everything downstream takes it as an argument.

import { Tonemapper } from "@cesium/engine";
import { Viewer } from "@cesium/widgets";

/**
 * No `animation` or `timeline` widget: `ClockDeck.vue` replaces both.
 * `minimalUI` (`DeviceDetect.minimalUI`) only hides the fullscreen button.
 */
export function createViewer(container: string | Element, options: { minimalUI: boolean }): Viewer {
  const { minimalUI } = options;

  const viewer = new Viewer(container, {
    animation: false,
    // The store's layer stack is the only default; sceneSync applies it a tick later.
    baseLayer: false,
    baseLayerPicker: false,
    // Outside #cesiumContainer's stacking context, so the lightbox covers the app's toolbars and clock deck
    creditViewport: document.body,
    fullscreenButton: !minimalUI,
    fullscreenElement: document.body,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    navigationInstructionsInitiallyVisible: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    contextOptions: {
      webgl: {
        alpha: true,
      },
    },
  });

  // Shorter than Cesium's "Data attribution": the breakpoints in `useClockDeckChrome`
  // and main.css are measured off this width. CreditDisplay sets the text only once.
  const expandLink = viewer.container.querySelector(".cesium-credit-expand-link");
  if (expandLink) {
    expandLink.textContent = "Attribution";
  }

  viewer.clock.shouldAnimate = true;
  viewer.scene.globe.enableLighting = true;
  viewer.scene.highDynamicRange = true;
  // Cesium's polylines have no antialiasing and MSAA misses the translucent orbits.
  // Free under HDR: FXAA's 8-bit output is cheaper to hand on than the float frame.
  viewer.scene.postProcessStages.fxaa.enabled = true;
  viewer.scene.maximumRenderTimeChange = 1 / 30;
  viewer.scene.requestRenderMode = true;
  // Not Cesium's PBR_NEUTRAL default: its black-point term subtracts min(r,g,b)
  // below linear 0.08, so near-black greys turn olive (sRGB (18,17,16) -> (9,7,2)).
  // Measured: mean saturation 0.598 vs ACES 0.260 under luminance 40; ACES costs
  // about 5% luminance on lit surfaces and the same frame time.
  viewer.scene.postProcessStages.tonemapper = Tonemapper.ACES;

  // Otherwise render-on-demand deadlocks: an unfinished geometry primitive clears
  // `clock.canAnimate`, time stops, `maximumRenderTimeChange` requests no frame, and
  // the primitive never finishes. The clock froze on the first ground-track corridor.
  viewer.allowDataSourcesToSuspendAnimation = false;

  return viewer;
}
