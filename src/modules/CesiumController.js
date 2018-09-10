// Import webpack externals
import Cesium from "Cesium";

export class CesiumController {
  constructor(hires = true) {
    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

    const imageryProvider = hires ?
      new Cesium.createTileMapServiceImageryProvider({
        url : "data/cesium-assets/imagery/NaturalEarthII",
        maximumLevel : 5,
        credit : "Imagery courtesy Natural Earth"
      })
      :
      new Cesium.createTileMapServiceImageryProvider({
        url: Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
      });

    this.viewer = new Cesium.Viewer("cesiumContainer", {
      animation: !this.isIOS,
      baseLayerPicker: false,
      fullscreenButton: !this.isIOS,
      fullscreenElement: document.body,
      geocoder: false,
      imageryProvider: imageryProvider,
      navigationHelpButton: false,
      navigationInstructionsInitiallyVisible: false,
      selectionIndicator: false,
      timeline: !this.isIOS,
      vrButton: true,
    });

    this.viewer.scene.debugShowFramesPerSecond = true;
    this.viewer.clock.shouldAnimate = true;

    // Export viewer variable for debugger
    window.viewer = this.viewer;
  }
}
