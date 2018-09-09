// Import webpack externals
import Cesium from "Cesium";

export class CesiumController {
  constructor() {
    const isLocalOnly = true;

    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    this.viewer = new Cesium.Viewer("cesiumContainer", {
      imageryProvider: isLocalOnly
      ? new Cesium.createTileMapServiceImageryProvider({
        url: Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
      })
      : new Cesium.ArcGisMapServerImageryProvider({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
      }),
      animation: !this.isIOS,
      baseLayerPicker: !isLocalOnly,
      fullscreenButton: !this.isIOS,
      fullscreenElement: document.body,
      geocoder: false,
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
