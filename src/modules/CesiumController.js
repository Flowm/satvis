// Import webpack externals
import Cesium from "Cesium";
import { SatelliteManager } from "./SatelliteManager";

export class CesiumController {
  constructor(imageryProvider = "offlinehighres") {
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

  createGroundStation(clickPosition) {
    console.log(clickPosition);
  }

  createInputHandler() {
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    handler.setInputAction((event) => {
      this.clickEventHandler(event, this.createGroundStation);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  clickEventHandler(event, callback) {
    const properties = {};
    properties.screenPosition = event.position;
    properties.position = this.viewer.camera.pickEllipsoid(event.position);
    properties.didHitGlobe = Cesium.defined(properties.position);
    if (properties.didHitGlobe) {
      const cartographicPosition = Cesium.Cartographic.fromCartesian(properties.position);
      properties.longitude = Cesium.Math.toDegrees(cartographicPosition.longitude);
      properties.latitude = Cesium.Math.toDegrees(cartographicPosition.latitude);
      properties.height = Cesium.Math.toDegrees(cartographicPosition.height);
    }
    callback(properties);
  }
}
