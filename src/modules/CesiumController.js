// Import webpack externals
import Cesium from "Cesium";
import dayjs from "dayjs";
import { DeviceDetect } from "./util/DeviceDetect";
import { SatelliteManager } from "./SatelliteManager";

export class CesiumController {
  constructor() {
    this.minimalUI = DeviceDetect.inIframe() || DeviceDetect.isIos();
    this.minimalUIAtStartup = DeviceDetect.inIframe();

    this.viewer = new Cesium.Viewer("cesiumContainer", {
      animation: !this.minimalUI,
      baseLayerPicker: false,
      fullscreenButton: !this.minimalUI,
      fullscreenElement: document.body,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      imageryProvider: this.createImageryProvider().provider,
      navigationHelpButton: false,
      navigationInstructionsInitiallyVisible: false,
      selectionIndicator: false,
      timeline: !this.minimalUI,
      vrButton: !this.minimalUI,
    });

    // Cesium default settings
    this.viewer.clock.shouldAnimate = true;
    this.viewer.scene.globe.enableLighting = true;
    this.viewer.scene.requestRenderMode = true;
    this.viewer.scene.maximumRenderTimeChange = 1/30;
    //this.viewer.scene.debugShowFramesPerSecond = true;

    // Export CesiumController for debugger
    window.cc = this;

    // CesiumController config
    this.imageryProviders = ["Offline", "OfflineHighres", "ArcGis", "OSM", "Tiles", "GOES-IR", "Nextrad", "Meteocool"];
    this.sceneModes = ["3D", "2D", "Columbus"];
    this.cameraModes = ["Fixed", "Inertial"];
    this.groundStationPicker = { enabled: false };

    this.createInputHandler();
    this.styleInfoBox();

    // Create Satellite Manager
    this.sats = new SatelliteManager(this.viewer);

    // Fix Cesium logo in minimal ui mode
    if (this.minimalUI) {
      setTimeout(() => { this.fixLogo(); }, 2000);
    }
  }

  set sceneMode(sceneMode) {
    switch(sceneMode) {
    case "3D":
      this.viewer.scene.morphTo3D();
      break;
    case "2D":
      this.viewer.scene.morphTo2D();
      break;
    case "Columbus":
      this.viewer.scene.morphToColumbusView();
      break;
    }
  }

  set imageryProvider(imageryProviderName) {
    if (!this.imageryProviders.includes(imageryProviderName)) {
      return;
    }

    const layers = this.viewer.scene.imageryLayers;
    layers.removeAll();
    layers.addImageryProvider(this.createImageryProvider(imageryProviderName).provider);
  }

  clearImageryLayers() {
    this.viewer.scene.imageryLayers.removeAll();
  }

  addImageryLayer(imageryProviderName, alpha) {
    if (!this.imageryProviders.includes(imageryProviderName)) {
      return;
    }

    const layers = this.viewer.scene.imageryLayers;
    const imagery = this.createImageryProvider(imageryProviderName);
    const layer = layers.addImageryProvider(imagery.provider);
    if (typeof alpha === "undefined") {
      alpha = imagery.alpha;
    }
    layer.alpha = alpha;
  }

  createImageryProvider(imageryProviderName = "OfflineHighres") {
    let provider;
    let alpha = 1;
    switch(imageryProviderName) {
    case "Offline":
      provider = new Cesium.createTileMapServiceImageryProvider({
        url: Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
      });
      break;
    case "OfflineHighres":
      provider = new Cesium.createTileMapServiceImageryProvider({
        url : "data/cesium-assets/imagery/NaturalEarthII",
        maximumLevel : 5,
        credit : "Imagery courtesy Natural Earth"
      });
      break;
    case "ArcGis":
      provider = new Cesium.ArcGisMapServerImageryProvider({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer",
      });
      break;
    case "OSM":
      provider = new Cesium.createOpenStreetMapImageryProvider({
        url : "https://a.tile.openstreetmap.org/"
      });
      break;
    case "Tiles":
      provider = new Cesium.TileCoordinatesImageryProvider();
      break;
    case "GOES-IR":
      provider = new Cesium.WebMapServiceImageryProvider({
        url : "https://mesonet.agron.iastate.edu/cgi-bin/wms/goes/conus_ir.cgi?",
        layers : "goes_conus_ir",
        credit : "Infrared data courtesy Iowa Environmental Mesonet",
        parameters : {
          transparent : "true",
          format : "image/png"
        }
      });
      alpha = 0.5;
      break;
    case "Nextrad":
      provider = new Cesium.WebMapServiceImageryProvider({
        url : "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi?",
        layers : "nexrad-n0r",
        credit : "US Radar data courtesy Iowa Environmental Mesonet",
        parameters : {
          transparent : "true",
          format : "image/png"
        }
      });
      alpha = 0.5;
      break;
    case "Meteocool":
      provider = new Cesium.UrlTemplateImageryProvider({
        url: "https://{s}.tileserver.unimplemented.org/data/{time}/{z}/{x}/{y}.png",
        rectangle: Cesium.Rectangle.fromDegrees(2.8125, 45, 19.6875, 56.25),
        minimumLevel: 6,
        maximumLevel: 10,
        credit : "DE Radar data courtesy of meteocool.com",
        subdomains: "ab",
        customTags: {
          time: (imageryProvider, x, y, level) => {
            const time = dayjs(Cesium.JulianDate.toDate(this.viewer.clock.currentTime));
            const diff = time.diff(dayjs(), "minute");
            if (diff >= 0) {
              return "raa01-wx_10000-latest-dwd-wgs84_transformed";
            } else if (diff >= -5) {
              return "FX_005-latest";
            } else if (diff >= -10) {
              return "FX_010-latest";
            } else if (diff >= -15) {
              return "FX_015-latest";
            } else if (diff >= -20) {
              return "FX_020-latest";
            } else if (diff >= -25) {
              return "FX_025-latest";
            } else if (diff >= -30) {
              return "FX_030-latest";
            } else if (diff >= -35) {
              return "FX_035-latest";
            } else if (diff >= -40) {
              return "FX_040-latest";
            } else {
              return "FX_045-latest";
            }
          }
        }
      });
      alpha = 0.5;
      break;
    }
    return { provider, alpha };
  }

  set cameraMode(cameraMode) {
    switch(cameraMode) {
    case "Inertial":
      this.viewer.scene.postUpdate.addEventListener(this.cameraTrackEci);
      break;
    case "Fixed":
      this.viewer.scene.postUpdate.removeEventListener(this.cameraTrackEci);
      break;
    }
  }

  cameraTrackEci(scene, time) {
    if (scene.mode !== Cesium.SceneMode.SCENE3D) {
      return;
    }

    const icrfToFixed = Cesium.Transforms.computeIcrfToFixedMatrix(time);
    if (Cesium.defined(icrfToFixed)) {
      const camera = scene.camera;
      const offset = Cesium.Cartesian3.clone(camera.position);
      const transform = Cesium.Matrix4.fromRotationTranslation(icrfToFixed);
      camera.lookAtTransform(transform, offset);
    }
  }

  setTime(current, start = dayjs(current).subtract(12, "hour").toISOString(), stop = dayjs(current).add(7, "day").toISOString()) {
    this.viewer.clock.startTime = Cesium.JulianDate.fromIso8601(dayjs(start).toISOString());
    this.viewer.clock.stopTime = Cesium.JulianDate.fromIso8601(dayjs(stop).toISOString());
    this.viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(dayjs(current).toISOString());
    this.viewer.timeline.updateFromClock();
    this.viewer.timeline.zoomTo(this.viewer.clock.startTime, this.viewer.clock.stopTime);
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

  setGroundStationFromLatLon(latlon) {
    let [latitude, longitude, height] = latlon.split(",");
    if (!latitude || !longitude) {
      return;
    }
    const coordinates = {};
    coordinates.longitude = parseFloat(longitude);
    coordinates.latitude = parseFloat(latitude);
    coordinates.height = 0;
    if (height) {
      coordinates.height = parseFloat(height);
    }
    coordinates.cartesian = Cesium.Cartesian3.fromDegrees(coordinates.longitude, coordinates.latitude, coordinates.height);
    this.sats.setGroundStation(coordinates);
  }

  set showUI(enabled) {
    if (enabled) {
      this.viewer._animation.container.style.visibility = "";
      this.viewer._timeline.container.style.visibility = "";
      this.viewer._fullscreenButton._container.style.visibility = "";
      this.viewer._vrButton._container.style.visibility = "";
      this.viewer._bottomContainer.style.left = this.oldBottomContainerStyleLeft;
      this.viewer._bottomContainer.style.bottom = "30px";
    } else {
      this.viewer._animation.container.style.visibility = "hidden";
      this.viewer._timeline.container.style.visibility = "hidden";
      this.viewer._fullscreenButton._container.style.visibility = "hidden";
      this.viewer._vrButton._container.style.visibility = "hidden";
      this.oldBottomContainerStyleLeft = this.viewer._bottomContainer.style.left;
      this.viewer._bottomContainer.style.left = "5px";
      this.viewer._bottomContainer.style.bottom = "0px";
    }
  }

  get showUI() {
    return this.viewer._timeline.container.style.visibility !== "hidden";
  }

  fixLogo() {
    if (this.minimalUI) {
      this.viewer._bottomContainer.style.left = "5px";
    }
    if (DeviceDetect.isiPhoneWithNotch()) {
      this.viewer._bottomContainer.style.bottom = "20px";
    }
  }

  styleInfoBox() {
    const infoBox = this.viewer.infoBox.container.getElementsByClassName("cesium-infoBox")[0];
    const close = this.viewer.infoBox.container.getElementsByClassName("cesium-infoBox-close")[0];
    if (infoBox && close) {
      // Container for additional buttons
      let container = document.createElement("div");
      container.setAttribute("class", "cesium-infoBox-container");
      infoBox.insertBefore(container, close);

      // Notify button
      let notifyButton = document.createElement("button");
      notifyButton.setAttribute("type", "button");
      notifyButton.setAttribute("class", "cesium-button cesium-infoBox-custom");
      notifyButton.innerHTML = "<i class=\"fas fa-bell\" />";
      notifyButton.addEventListener("click", () => {
        if (this.sats.selectedSatellite) {
          this.sats.getSatellite(this.sats.selectedSatellite).props.notifyPasses();
        } else if (this.sats.groundStationAvailable && this.sats.groundStation.isSelected) {
          this.sats.enabledSatellites.forEach((sat) => {
            sat.props.notifyPasses();
          });
        }
      });
      container.appendChild(notifyButton);

      // Info button
      let infoButton = document.createElement("button");
      infoButton.setAttribute("type", "button");
      infoButton.setAttribute("class", "cesium-button cesium-infoBox-custom");
      infoButton.innerHTML = "<i class=\"fas fa-info\" />";
      infoButton.addEventListener("click", () => {
        if (!this.sats.selectedSatellite) {
          return;
        }
        const satnum = this.sats.getSatellite(this.sats.selectedSatellite).props.satnum;
        const url = "https://www.n2yo.com/satellite/?s=" + satnum;
        window.open(url, "_blank", "noopener");
      });
      container.appendChild(infoButton);
    }

    const frame = this.viewer.infoBox.frame;
    frame.addEventListener("load", function () {
      // Inline infobox css as iframe does not use service worker
      const head = frame.contentDocument.head;
      const links = head.getElementsByTagName("link");
      for (const link of links) {
        head.removeChild(link);
      }
      const css = require("to-string-loader!css-loader!postcss-loader!../css/infobox.ecss");
      const style = frame.contentDocument.createElement("style");
      var node = document.createTextNode(css);
      style.appendChild(node);
      head.appendChild(style);
    }, false);
  }
}
