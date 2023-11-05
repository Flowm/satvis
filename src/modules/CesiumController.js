import * as Cesium from "@cesium/engine";
import { Viewer } from "@cesium/widgets";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import * as Sentry from "@sentry/browser";
import { icon } from "@fortawesome/fontawesome-svg-core";
import { faBell, faInfo } from "@fortawesome/free-solid-svg-icons";

import { DeviceDetect } from "./util/DeviceDetect";
import { CesiumPerformanceStats } from "./util/CesiumPerformanceStats";
import { SatelliteManager } from "./SatelliteManager";
import { useCesiumStore } from "../stores/cesium";
import infoBoxCss from "../css/infobox.ecss";

dayjs.extend(utc);

export class CesiumController {
  constructor() {
    this.initConstants();
    this.preloadReferenceFrameData();
    this.minimalUI = DeviceDetect.inIframe() || DeviceDetect.isIos();

    this.viewer = new Viewer("cesiumContainer", {
      animation: !this.minimalUI,
      baseLayer: this.createImageryLayer("OfflineHighres"),
      baseLayerPicker: false,
      fullscreenButton: !this.minimalUI,
      fullscreenElement: document.body,
      geocoder: false,
      homeButton: false,
      navigationHelpButton: false,
      navigationInstructionsInitiallyVisible: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: !this.minimalUI,
      vrButton: !this.minimalUI,
      contextOptions: {
        webgl: {
          alpha: true,
        },
      },
    });

    // Cesium default settings
    this.viewer.clock.shouldAnimate = true;
    this.viewer.scene.globe.enableLighting = true;
    this.viewer.scene.highDynamicRange = true;
    this.viewer.scene.maximumRenderTimeChange = 1 / 30;
    this.viewer.scene.requestRenderMode = true;

    // Cesium Performance Tools
    // this.viewer.scene.debugShowFramesPerSecond = true;
    // this.FrameRateMonitor = Cesium.FrameRateMonitor.fromScene(this.viewer.scene);
    // this.viewer.scene.postRender.addEventListener((scene) => {
    //   console.log(this.FrameRateMonitor.lastFramesPerSecond)
    // });
    // this.enablePerformanceLogger(true);

    // Export CesiumController for debugger
    window.cc = this;

    // CesiumController config
    this.terrainProviders = ["None", "Maptiler"];
    this.sceneModes = ["3D", "2D", "Columbus"];
    this.cameraModes = ["Fixed", "Inertial"];

    this.createInputHandler();
    this.addErrorHandler();
    this.styleInfoBox();

    // Create Satellite Manager
    this.sats = new SatelliteManager(this.viewer);

    // Add privacy policy to credits when not running in iframe
    if (!DeviceDetect.inIframe()) {
      this.viewer.creditDisplay.addStaticCredit(new Cesium.Credit(`<a href="/privacy.html" target="_blank"><u>Privacy</u></a>`, true));
    }
    this.viewer.creditDisplay.addStaticCredit(new Cesium.Credit(`Satellite TLE data provided by <a href="https://celestrak.org/NORAD/elements/" target="_blank"><u>Celestrak</u></a>`));

    // Fix Cesium logo in minimal ui mode
    if (this.minimalUI) {
      setTimeout(() => { this.fixLogo(); }, 2500);
    }

    this.activeLayers = [];
  }

  initConstants() {
    this.imageryProviders = {
      Offline: {
        create: () => Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")),
        alpha: 1,
        base: true,
      },
      OfflineHighres: {
        create: () => Cesium.TileMapServiceImageryProvider.fromUrl("data/cesium-assets/imagery/NaturalEarthII", {
          maximumLevel: 5,
          credit: "Imagery courtesy Natural Earth",
        }),
        alpha: 1,
        base: true,
      },
      ArcGis: {
        create: () => Cesium.ArcGisMapServerImageryProvider.fromUrl("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"),
        alpha: 1,
        base: true,
      },
      OSM: {
        create: () => new Cesium.OpenStreetMapImageryProvider({
          url: "https://a.tile.openstreetmap.org/",
        }),
        alpha: 1,
        base: true,
      },
      Topo: {
        create: () => new Cesium.UrlTemplateImageryProvider({
          url: "https://api.maptiler.com/maps/topo-v2/{z}/{x}/{y}@2x.png?key=tiHE8Ed08u6ZoFjbE32Z",
          credit: `<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>`,
        }),
        alpha: 1,
        base: true,
      },
      BlackMarble: {
        create: () => new Cesium.WebMapServiceImageryProvider({
          url: "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi",
          layers: "VIIRS_Black_Marble",
          style: "default",
          tileMatrixSetID: "250m",
          format: "image/png",
          tileWidth: 512,
          tileHeight: 512,
          credit: "NASA Global Imagery Browse Services for EOSDIS",
        }),
        alpha: 1,
        base: true,
      },
      Tiles: {
        create: () => new Cesium.TileCoordinatesImageryProvider(),
        alpha: 1,
        base: false,
      },
      "GOES-IR": {
        create: () => new Cesium.WebMapServiceImageryProvider({
          url: "https://mesonet.agron.iastate.edu/cgi-bin/wms/goes/conus_ir.cgi?",
          layers: "goes_conus_ir",
          credit: "Infrared data courtesy Iowa Environmental Mesonet",
          parameters: {
            transparent: "true",
            format: "image/png",
          },
        }),
        alpha: 0.5,
        base: false,
      },
      Nextrad: {
        create: () => new Cesium.WebMapServiceImageryProvider({
          url: "https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi?",
          layers: "nexrad-n0r",
          credit: "US Radar data courtesy Iowa Environmental Mesonet",
          parameters: {
            transparent: "true",
            format: "image/png",
          },
        }),
        alpha: 0.5,
        base: false,
      },
    };
  }

  preloadReferenceFrameData() {
    // Preload reference frame data for a timeframe of 180 days
    const timeInterval = new Cesium.TimeInterval({
      start: Cesium.JulianDate.addDays(Cesium.JulianDate.now(), -60, new Cesium.JulianDate()),
      stop: Cesium.JulianDate.addDays(Cesium.JulianDate.now(), 120, new Cesium.JulianDate()),
    });
    Cesium.Transforms.preloadIcrfFixed(timeInterval).then(() => {
      console.log("Reference frame data loaded");
    });
  }

  get imageryProviderNames() {
    return Object.keys(this.imageryProviders);
  }

  get baseLayers() {
    return Object.entries(this.imageryProviders).filter(([, val]) => val.base).map(([key]) => key);
  }

  get overlayLayers() {
    return Object.entries(this.imageryProviders).filter(([, val]) => !val.base).map(([key]) => key);
  }

  set imageryLayers(newLayerNames) {
    this.clearImageryLayers();
    newLayerNames.forEach((layerName) => {
      const [name, alpha] = layerName.split("_");
      const layer = this.createImageryLayer(name, alpha);
      if (layer) {
        this.viewer.scene.imageryLayers.add(layer);
      }
    });
  }

  clearImageryLayers() {
    this.viewer.scene.imageryLayers.removeAll();
  }

  createImageryLayer(imageryProviderName, alpha) {
    if (!this.imageryProviderNames.includes(imageryProviderName)) {
      console.error("Unknown imagery layer");
      return false;
    }

    const provider = this.imageryProviders[imageryProviderName];
    const layer = Cesium.ImageryLayer.fromProviderAsync(provider.create());
    if (alpha === undefined) {
      layer.alpha = provider.alpha;
    } else {
      layer.alpha = alpha;
    }
    return layer;
  }

  set sceneMode(sceneMode) {
    switch (sceneMode) {
      case "3D":
        this.viewer.scene.morphTo3D();
        break;
      case "2D":
        this.viewer.scene.morphTo2D();
        break;
      case "Columbus":
        this.viewer.scene.morphToColumbusView();
        break;
      default:
        console.error("Unknown scene mode");
    }
  }

  set terrainProvider(terrainProviderName) {
    if (!this.terrainProviders.includes(terrainProviderName)) {
      return;
    }

    switch (terrainProviderName) {
      case "None":
        this.viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        break;
      case "Maptiler":
        this.viewer.terrainProvider = new Cesium.CesiumTerrainProvider({
          url: "https://api.maptiler.com/tiles/terrain-quantized-mesh/?key=tiHE8Ed08u6ZoFjbE32Z",
          credit: "<a href=\"https://www.maptiler.com/copyright/\" target=\"_blank\">© MapTiler</a> <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\">© OpenStreetMap contributors</a>",
          requestVertexNormals: true,
        });
        break;
      case "ArcGIS":
        this.viewer.terrainProvider = new Cesium.ArcGISTiledElevationTerrainProvider({
          url: "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer",
        });
        break;
      default:
        console.error("Unknown terrain provider");
    }
  }

  jumpTo(location) {
    switch (location) {
      case "Everest": {
        const target = new Cesium.Cartesian3(300770.50872389384, 5634912.131394585, 2978152.2865545116);
        const offset = new Cesium.Cartesian3(6344.974098678562, -793.3419798081741, 2499.9508860763162);
        this.viewer.camera.lookAt(target, offset);
        this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        break;
      }
      case "HalfDome": {
        const target = new Cesium.Cartesian3(-2489625.0836225147, -4393941.44443024, 3882535.9454173897);
        const offset = new Cesium.Cartesian3(-6857.40902037546, 412.3284835694358, 2147.5545426812023);
        this.viewer.camera.lookAt(target, offset);
        this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        break;
      }
      default:
        console.error("Unknown location");
    }
  }

  set cameraMode(cameraMode) {
    switch (cameraMode) {
      case "Inertial":
        this.viewer.scene.postUpdate.addEventListener(this.cameraTrackEci);
        break;
      case "Fixed":
        this.viewer.scene.postUpdate.removeEventListener(this.cameraTrackEci);
        break;
      default:
        console.error("Unknown camera mode");
    }
  }

  cameraTrackEci(scene, time) {
    if (scene.mode !== Cesium.SceneMode.SCENE3D) {
      return;
    }

    const icrfToFixed = Cesium.Transforms.computeIcrfToFixedMatrix(time);
    if (Cesium.defined(icrfToFixed)) {
      const { camera } = scene;
      const offset = Cesium.Cartesian3.clone(camera.position);
      const transform = Cesium.Matrix4.fromRotationTranslation(icrfToFixed);
      camera.lookAtTransform(transform, offset);
    }
  }

  setTime(current, start = dayjs.utc(current).subtract(12, "hour").toISOString(), stop = dayjs.utc(current).add(7, "day").toISOString()) {
    this.viewer.clock.startTime = Cesium.JulianDate.fromIso8601(dayjs.utc(start).toISOString());
    this.viewer.clock.stopTime = Cesium.JulianDate.fromIso8601(dayjs.utc(stop).toISOString());
    this.viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(dayjs.utc(current).toISOString());
    if (typeof this.viewer.timeline !== "undefined") {
      this.viewer.timeline.updateFromClock();
      this.viewer.timeline.zoomTo(this.viewer.clock.startTime, this.viewer.clock.stopTime);
    }
  }

  createInputHandler() {
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    handler.setInputAction((event) => {
      const { pickMode } = useCesiumStore();
      if (!pickMode) {
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
      useCesiumStore().pickMode = false;
    }
  }

  setGroundStationFromGeolocation() {
    navigator.geolocation.getCurrentPosition((position) => {
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

  setGroundStationFromLatLon(lat, lon, height = 0) {
    if (!lat || !lon) {
      return;
    }
    const coordinates = {
      longitude: lon,
      latitude: lat,
      height,
    };
    coordinates.longitude = lon;
    coordinates.latitude = lat;
    coordinates.height = height;
    coordinates.cartesian = Cesium.Cartesian3.fromDegrees(coordinates.longitude, coordinates.latitude, coordinates.height);
    this.sats.setGroundStation(coordinates);
  }

  set showUI(enabled) {
    if (enabled) {
      /* eslint-disable no-underscore-dangle */
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
      /* eslint-enable no-underscore-dangle */
    }
  }

  get showUI() {
    // eslint-disable-next-line
    return this.viewer._timeline.container.style.visibility !== "hidden";
  }

  fixLogo() {
    if (this.minimalUI) {
      // eslint-disable-next-line
      this.viewer._bottomContainer.style.left = "5px";
    }
    if (DeviceDetect.isiPhoneWithNotchVisible()) {
      // eslint-disable-next-line
      this.viewer._bottomContainer.style.bottom = "20px";
    }
  }

  set qualityPreset(quality) {
    switch (quality) {
      case "low":
        // Ignore browser's device pixel ratio and use CSS pixels instead of device pixels for render resolution
        this.viewer.useBrowserRecommendedResolution = true;
        break;
      case "high":
        // Use browser's device pixel ratio for render resolution
        this.viewer.useBrowserRecommendedResolution = false;
        break;
      default:
        console.error("Unknown quality preset");
    }
  }

  set showFps(value) {
    cc.viewer.scene.debugShowFramesPerSecond = value;
  }

  set background(active) {
    if (!active) {
      this.viewer.scene.backgroundColor = Cesium.Color.TRANSPARENT;
      this.viewer.scene.moon = undefined;
      this.viewer.scene.skyAtmosphere = undefined;
      this.viewer.scene.skyBox = undefined;
      this.viewer.scene.sun = undefined;
      document.documentElement.style.background = "transparent";
      document.body.style.background = "transparent";
      document.getElementById("cesiumContainer").style.background = "transparent";
    }
  }

  enablePerformanceStats(logContinuously = false) {
    this.performanceStats = new CesiumPerformanceStats(this.viewer.scene, logContinuously);
  }

  addErrorHandler() {
    // Rethrow scene render errors
    this.viewer.scene.rethrowRenderErrors = true;
    this.viewer.scene.renderError.addEventListener((scene, error) => {
      console.error(scene, error);
      Sentry.captureException(error);
    });

    // Proxy and log CesiumWidget render loop errors that only display a UI error message
    const widget = this.viewer.cesiumWidget;
    const proxied = widget.showErrorPanel;
    widget.showErrorPanel = function widgetError(title, message, error) {
      proxied.apply(this, [title, message, error]);
      Sentry.captureException(error);
    };
  }

  styleInfoBox() {
    const infoBox = this.viewer.infoBox.container.getElementsByClassName("cesium-infoBox")[0];
    const close = this.viewer.infoBox.container.getElementsByClassName("cesium-infoBox-close")[0];
    if (infoBox && close) {
      // Container for additional buttons
      const container = document.createElement("div");
      container.setAttribute("class", "cesium-infoBox-container");
      infoBox.insertBefore(container, close);

      // Notify button
      const notifyButton = document.createElement("button");
      notifyButton.setAttribute("type", "button");
      notifyButton.setAttribute("class", "cesium-button cesium-infoBox-custom");
      notifyButton.innerHTML = icon(faBell).html;
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
      const infoButton = document.createElement("button");
      infoButton.setAttribute("type", "button");
      infoButton.setAttribute("class", "cesium-button cesium-infoBox-custom");
      infoButton.innerHTML = icon(faInfo).html;
      infoButton.addEventListener("click", () => {
        if (!this.sats.selectedSatellite) {
          return;
        }
        const { satnum } = this.sats.getSatellite(this.sats.selectedSatellite).props;
        const url = `https://www.n2yo.com/satellite/?s=${satnum}`;
        window.open(url, "_blank", "noopener");
      });
      container.appendChild(infoButton);
    }

    const { frame } = this.viewer.infoBox;
    frame.addEventListener("load", () => {
      // Inline infobox css as iframe does not use service worker
      const { head } = frame.contentDocument;
      const links = head.getElementsByTagName("link");
      [...links].forEach((link) => {
        head.removeChild(link);
      });

      const style = frame.contentDocument.createElement("style");
      const css = infoBoxCss.toString();
      const node = document.createTextNode(css);
      style.appendChild(node);
      head.appendChild(style);
    }, false);
  }
}
