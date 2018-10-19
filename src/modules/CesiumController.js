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

    // Cesium default settings
    //this.viewer.scene.debugShowFramesPerSecond = true;
    this.viewer.scene.globe.enableLighting = true;
    this.viewer.clock.shouldAnimate = true;

    // Export CesiumController for debugger
    window.cc = this;

    // CesiumController config
    this.imageryProviders = {
      offline: "Offline",
      offlinehighres: "Offline Highres",
      arcgis: "ArcGis",
      osm: "OSM",
    };
    this.sceneModes = ["3D", "2D", "Columbus"];
    this.groundStationPicker = { enabled: false };

    this.createInputHandler();
    this.styleInfoBox();

    // Create Satellite Manager
    this.sats = new SatelliteManager(this.viewer);
  }

  set setSceneMode(sceneMode) {
    switch(sceneMode) {
    case "3D":
      this.viewer.scene.morphTo3D()
      break;
    case "2D":
      this.viewer.scene.morphTo2D()
      break;
    case "Columbus":
      this.viewer.scene.morphToColumbusView()
      break;
    }
  }

  set setImageryProvider(imageryProvider) {
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
      if (!this.groundStationPicker.enabled) {
        return;
      }
      this.setGroundStationFromClickEvent(event);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  setGroundStationFromClickEvent(event) {
    const cartesian = this.viewer.camera.pickEllipsoid(event.position);
    const didHitGlobe = Cesium.defined(cartesian);
    if (didHitGlobe) {
      const coordinates = {};
      const cartographicPosition = Cesium.Cartographic.fromCartesian(cartesian);
      coordinates.longitude = Cesium.Math.toDegrees(cartographicPosition.longitude);
      coordinates.latitude = Cesium.Math.toDegrees(cartographicPosition.latitude);
      coordinates.height = Cesium.Math.toDegrees(cartographicPosition.height);
      coordinates.cartesian = cartesian;
      this.sats.setGroundStation(coordinates);
      this.groundStationPicker.enabled = false;
    }
  }

  setGroundStationFromGeolocation() {
    navigator.geolocation.getCurrentPosition(position => {
      if (typeof position === "undefined") {
        return;
      }
      const coordinates = {};
      coordinates.longitude = position.coords.longitude;
      coordinates.latitude = position.coords.latitude;
      coordinates.height = position.coords.altitude;
      coordinates.cartesian = Cesium.Cartesian3.fromDegrees(coordinates.longitude, coordinates.latitude, coordinates.height);
      this.sats.setGroundStation(coordinates);
    });
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
