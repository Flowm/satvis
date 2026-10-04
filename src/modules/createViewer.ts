// The one module that names a DOM container and asks for a WebGL context.
//
// Split out of CesiumController's constructor, which used to do this itself
// against a hardcoded element id. Nothing else in the app constructs a Viewer,
// so this is the only file that cannot run outside a browser — and everything
// downstream of it takes the viewer as an argument instead of making one.

import { Tonemapper } from "@cesium/engine";
import { Viewer } from "@cesium/widgets";

/**
 * A viewer with this app's widget selection and scene defaults already applied.
 *
 * No `animation` and no `timeline` on any device: the clock deck replaces both
 * (`ClockDeck.vue`), and neither widget fits a phone's width.
 *
 * `minimalUI` is the caller's answer, not this module's, and decides only the
 * fullscreen button: nothing to do in an iframe, no meaning on iOS. Read once
 * (`DeviceDetect.minimalUI`) rather than re-derived per consumer.
 */
export function createViewer(container: string | Element, options: { minimalUI: boolean }): Viewer {
  const { minimalUI } = options;

  const viewer = new Viewer(container, {
    animation: false,
    // No base layer here: the store's layer stack is the only default, and it
    // arrives through sceneSync's immediate watcher a tick later. Naming one here
    // as well meant two defaults that could drift.
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

  // Cesium's own wording for the lightbox link is "Data attribution", which is 28 px
  // of a credit line the clock deck has to share the bottom row with — and the two
  // breakpoints that decide where that line goes are measured off its width
  // (`useClockDeckChrome`, and the corner rule in main.css). "Attribution" says the
  // same thing about the same lightbox.
  //
  // Written once, because CreditDisplay sets this text in its constructor and never
  // rewrites it: only the credit list beside it is rebuilt as credits come and go.
  const expandLink = viewer.container.querySelector(".cesium-credit-expand-link");
  if (expandLink) {
    expandLink.textContent = "Attribution";
  }

  viewer.clock.shouldAnimate = true;
  viewer.scene.globe.enableLighting = true;
  viewer.scene.highDynamicRange = true;
  viewer.scene.maximumRenderTimeChange = 1 / 30;
  viewer.scene.requestRenderMode = true;
  // Away from Cesium's PBR_NEUTRAL default, because that curve is wrong for a
  // scene this dark.
  //
  // Its black-point term subtracts min(r,g,b) from every channel while that
  // minimum is under linear 0.08 (see czm_pbrNeutralTonemapping). On a near-black
  // pixel the minimum is nearly the whole signal, so the subtraction strips the
  // achromatic part and leaves only the channel imbalance — which czm_inverseGamma
  // then stretches. A neutral sRGB grey of (18,17,16) comes out around (9,7,2).
  //
  // Measured, not assumed. It renders the faint sky as olive mottling at any star
  // map resolution (src/config/starMaps.ts), and it is not confined to the sky:
  // over Manhattan with OSM Buildings, 37% of the frame sits under luminance 40,
  // and there it claims a mean saturation of 0.598 against ACES's 0.260. Shadowed
  // building faces get the same treatment as the sky.
  //
  // ACES costs about 5% luminance and 6% saturation on properly lit surfaces, and
  // agrees with PBR_NEUTRAL to within 6% in the 80-140 luminance band, with a mean
  // absolute channel delta under 11 everywhere — the globe and the satellite models
  // are visually unchanged. Same pass count either way, so no frame-time change.
  viewer.scene.postProcessStages.tonemapper = Tonemapper.ACES;

  // Otherwise render-on-demand and Cesium's "wait for the data sources" rule
  // deadlock each other.
  //
  // A static geometry primitive is built asynchronously and only advances a
  // state per render. While it is unfinished `DataSourceDisplay.update` reports
  // false, and by default the Viewer answers that by clearing `clock.canAnimate`
  // — so simulation time stops. But `maximumRenderTimeChange` above is what asks
  // for the next frame, and it asks based on simulation time having moved. Time
  // cannot move until the primitive is ready, the primitive cannot become ready
  // without frames, and no frame is requested: the clock stops dead the first
  // time a ground-track corridor is switched on and never restarts.
  //
  // Nothing here needs the guarantee it gives up. Suspending animation exists so
  // a CZML clip does not run ahead of geometry still streaming in; every
  // geometry in this app is generated locally from a propagator, and a swath
  // corridor arriving a frame late is not worth stopping time over.
  viewer.allowDataSourcesToSuspendAnimation = false;

  return viewer;
}
