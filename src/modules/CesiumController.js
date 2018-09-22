// Import webpack externals
import Cesium from "Cesium";
import { SatelliteManager } from "./SatelliteManager";

export class CesiumController {
  constructor(imageryProvider = "offline") {
    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    this.viewer = new Cesium.Viewer("cesiumContainer", {
      animation: !this.isIOS,
      baseLayerPicker: false,
      fullscreenButton: !this.isIOS,
      fullscreenElement: document.body,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      imageryProvider: this.createImageryProvider(imageryProvider),
      navigationHelpButton: false,
      navigationInstructionsInitiallyVisible: false,
      selectionIndicator: false,
      timeline: !this.isIOS,
      vrButton: true,
    });

    //this.viewer.scene.debugShowFramesPerSecond = true;
    this.viewer.clock.shouldAnimate = true;

    // Export CesiumController for debugger
    window.cc = this;

    this.imageryProviders = {
      offline: "Offline",
      offlinehighres: "Offline Highres",
      arcgis: "ArcGis",
      osm: "OSM",
    };

    this.createInputHandler();
    this.styleInfoBox();

    // Create Satellite Manager
    this.sats = new SatelliteManager(this.viewer);
  }

  changeImageryProvider(imageryProvider) {
    if (!this.imageryProviders.hasOwnProperty(imageryProvider)) {
      return;
    }

    const layers = this.viewer.scene.imageryLayers;
    layers.removeAll();
    layers.addImageryProvider(this.createImageryProvider(imageryProvider));
  }

  createImageryProvider(imageryProvider = "offline") {
    let provider;
    switch(imageryProvider) {
    case "offline":
      provider = new Cesium.createTileMapServiceImageryProvider({
        url: Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
      });
      break;
    case "offlinehighres":
      provider = new Cesium.createTileMapServiceImageryProvider({
        url : "data/cesium-assets/imagery/NaturalEarthII",
        maximumLevel : 5,
        credit : "Imagery courtesy Natural Earth"
      });
      break;
    case "arcgis":
      provider = new Cesium.ArcGisMapServerImageryProvider({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
      });
      break;
    case "osm":
      provider = new Cesium.createOpenStreetMapImageryProvider({
        url : "https://a.tile.openstreetmap.org/"
      });
      break;
    }
    return provider;
  }

  createInputHandler() {
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    handler.setInputAction((event) => {
      const properties = this.clickEventHandler(event);
      if (properties.didHitGlobe) {
        this.sats.setGroundStation(properties);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  clickEventHandler(event) {
    const properties = {};
    //properties.screenPosition = event.position;
    properties.cartesian = this.viewer.camera.pickEllipsoid(event.position);
    properties.didHitGlobe = Cesium.defined(properties.cartesian);
    if (properties.didHitGlobe) {
      const cartographicPosition = Cesium.Cartographic.fromCartesian(properties.cartesian);
      properties.lon = Cesium.Math.toDegrees(cartographicPosition.longitude);
      properties.lat = Cesium.Math.toDegrees(cartographicPosition.latitude);
      properties.alt = Cesium.Math.toDegrees(cartographicPosition.height);
      if (properties.height < 0) {
        properties.height = 0;
      }
    }
    return properties;
  }

  styleInfoBox() {
    const frame = this.viewer.infoBox.frame;
    frame.addEventListener("load", function () {
      // Inline infobox css as iframe does not use service worker
      const head = frame.contentDocument.head;
      const links = head.getElementsByTagName("link");
      for (const link of links) {
        head.removeChild(link);
      }
      const css = require('to-string-loader!css-loader!postcss-loader!../css/infobox.ecss');
      const style = frame.contentDocument.createElement("style");
      var node = document.createTextNode(css);
      style.appendChild(node);
      head.appendChild(style);
    }, false);
  }
}
