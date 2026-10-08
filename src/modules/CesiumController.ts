import {
  Cartesian3,
  Cartographic,
  type CesiumWidget,
  Color,
  Credit,
  ImageryLayer,
  JulianDate,
  Math as CesiumMath,
  Matrix4,
  PerspectiveFrustum,
  Resource,
  type Scene,
  sampleTerrainMostDetailed,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  SkyBox,
  type TerrainProvider,
  TimeInterval,
  Transforms,
  defined,
} from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import { currentPosition } from "../composables/useGeolocation";
import { usePostHog } from "../composables/usePostHog";
import { useToastProxy } from "../composables/useToastProxy";
import { defaultViewDistance } from "../config/defaultView";
import { parseLayer } from "../config/layers";
import { MSAA_RATES, PIXEL_RATIOS, msaaSamplesFor, resolutionScaleFor } from "../config/rendering";
import { STAR_MAPS, type StarMapSources, starMapSources } from "../config/starMaps";
import { CAMERA_MODES, SCENE_MODES } from "../config/viewModes";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import {
  baseLayerNames,
  type ImageryContext,
  type ImageryProviderEntry,
  imageryProviders,
  overlayLayerNames,
  type TerrainProviderEntry,
  terrainProviders,
  terrainProviderNames as visibleTerrainProviderNames,
} from "./CesiumLayerProviders";
import { BATCHED_COMPONENTS } from "./componentKinds";
import { cesiumSceneMode } from "./satelliteGraphics";
import { SatelliteManager } from "./SatelliteManager";
import { SkyInteraction } from "./SkyInteraction";
import { type Observer, SkyView } from "./SkyView";
import { SurfaceModel } from "./SurfaceModel";
import { CesiumPerformanceStats } from "./util/CesiumPerformanceStats";
import { DeviceDetect } from "./util/DeviceDetect";
import { PushManager } from "./util/PushManager";
import { Suppressible } from "./util/Suppressible";

dayjs.extend(utc);

/**
 * Degrees. A little north, so Europe clears the limb without cutting off the southern hemisphere.
 */
const DEFAULT_VIEW_LON = 15;
const DEFAULT_VIEW_LAT = 25;

/**
 * A failed tile gives a `RequestErrorEvent` with no message or stack, which error
 * tracking files under a minified name per release. Wrap it, keeping it as `cause`.
 */
export function reportableError(error: unknown, title: string, message?: string): Error {
  if (error instanceof Error) {
    return error;
  }
  const detail = [title, message].filter(Boolean).join(" — ");
  return new Error(`Cesium: ${detail || "render error"}`, { cause: error });
}

/**
 * Cesium's `_canRender` reads the canvas CSS box, so it misses a drawing buffer
 * withdrawn on context loss; `GlobeDepth` then throws on a zero-width texture.
 * A skipped frame still ticks the clock, as Cesium does when `_canRender` is false.
 */
export function skipUnsizedFrames(widget: CesiumWidget): void {
  const { scene, clock } = widget;
  const proxied = widget.render;
  widget.render = function guardedRender(this: unknown) {
    if (scene.drawingBufferWidth === 0 || scene.drawingBufferHeight === 0) {
      clock.tick();
      return;
    }
    proxied.apply(this, []);
  };
}

export class CesiumController {
  viewer: Viewer;

  minimalUI: boolean;

  sats!: SatelliteManager;

  skyView!: SkyView;

  skyInteraction!: SkyInteraction;

  surface!: SurfaceModel;

  pm!: PushManager;

  sceneModes: string[] = [];

  cameraModes: string[] = [];

  activeLayers: string[] = [];

  performanceStats: CesiumPerformanceStats | undefined;

  #uiVisible: boolean = true;

  #removeCameraTrackEci: (() => void) | undefined;

  /** Aborted when the imagery layers are replaced, detaching any that follow the clock. */
  #imageryLifetime = new AbortController();

  /** "Fixed" or "Inertial". The sky view suppresses it with "Fixed". */
  readonly camera: Suppressible<string>;

  /** A surface model can suppress it (ADR 0005). */
  readonly terrain: Suppressible<string>;

  /** Reports a selection once, not on every view-mode re-apply. */
  #selectedSurfaceModel: string | undefined;

  /** The `applyStarMap` call that started last wins, not the one whose faces arrive last. */
  #starMapGeneration = 0;

  /** Set by `keepSelectionOnEmptyClick` for the click being released. */
  #keepSelection = false;

  constructor(viewer: Viewer) {
    this.preloadReferenceFrameData();
    this.minimalUI = DeviceDetect.minimalUI();

    this.viewer = viewer;
    this.setDefaultView();

    this.camera = new Suppressible<string>("Fixed", (mode) => this.#applyCameraMode(mode));
    this.terrain = new Suppressible<string>("None", (name, isCurrent) => this.#applyTerrain(name, isCurrent));

    this.sceneModes = [...SCENE_MODES];
    this.cameraModes = [...CAMERA_MODES];

    this.createInputHandler();
    this.addErrorHandler();
    skipUnsizedFrames(this.viewer.cesiumWidget);

    this.sats = new SatelliteManager(this.viewer);

    // The satellites' labels, which live in `viewer.entities`' cluster.
    this.skyView = new SkyView(this.viewer.scene, () => this.viewer.dataSourceDisplay.defaultDataSource.clustering._labelCollection);
    this.skyInteraction = new SkyInteraction({
      scene: this.viewer.scene,
      skyView: this.skyView,
      sats: this.sats,
      viewerInputs: this.viewer.screenSpaceEventHandler,
      onSelect: (target) => {
        this.viewer.selectedEntity = target.sat.defaultEntity;
      },
    });

    this.surface = new SurfaceModel({
      scene: this.viewer.scene,
      setTerrainOverride: (name) => (name === undefined ? this.releaseTerrain() : this.suppressTerrain(name)),
      skyLanded: () => this.skyView.settled,
      onFailure: (name, error) => {
        // Back to None so the radio, the url and the scene agree. The usual cause is
        // an ion token not valid for this origin, so say so.
        useCesiumStore().surfaceModel = "None";
        useToastProxy().add({
          title: `${name} unavailable`,
          description: `${error instanceof Error ? error.message : "The tileset could not be loaded"}. Cesium ion needs a token valid for this origin.`,
          color: "warning",
        });
      },
    });

    this.skyView.setGroundHeightSource((observer) => this.#observerGroundHeight(observer));
    // The photorealistic mesh is withheld until the descent lands, and only its showing
    // makes it the ground: re-measured only on a change of model, the eye stayed at the
    // ellipsoid, 559 m inside the mesh in Munich.
    this.surface.onChange(() => this.skyView.remeasureGround());

    this.pm = new PushManager();

    if (!DeviceDetect.inIframe()) {
      this.viewer.creditDisplay.addStaticCredit(new Credit(`<a href="/data/privacy.html" target="_blank"><u>Privacy</u></a>`, true));
    }
    this.viewer.creditDisplay.addStaticCredit(new Credit(`Satellite TLE data provided by <a href="https://celestrak.org/NORAD/elements/" target="_blank"><u>Celestrak</u></a>`));

    if (this.minimalUI) {
      setTimeout(() => {
        this.fixLogo();
      }, 2500);
    }

    this.activeLayers = [];
  }

  /**
   * Frames the whole globe at any aspect ratio. Not `Camera.DEFAULT_VIEW_RECTANGLE`:
   * a rectangle lands at 12,700 km on a phone and clips the globe there.
   */
  setDefaultView(): void {
    const { camera, canvas, globe } = this.viewer.scene;
    if (!(camera.frustum instanceof PerspectiveFrustum) || camera.frustum.fov === undefined) {
      return;
    }
    const aspectRatio = canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 1;
    // The equatorial radius, because that is the widest the disc can be.
    const radius = globe.ellipsoid.maximumRadius;
    const height = defaultViewDistance(camera.frustum.fov, aspectRatio, radius) - radius;
    camera.setView({ destination: Cartesian3.fromDegrees(DEFAULT_VIEW_LON, DEFAULT_VIEW_LAT, height) });
  }

  preloadReferenceFrameData(): void {
    const timeInterval = new TimeInterval({
      start: JulianDate.addDays(JulianDate.now(), -60, new JulianDate()),
      stop: JulianDate.addDays(JulianDate.now(), 120, new JulianDate()),
    });
    Transforms.preloadIcrfFixed(timeInterval).then(() => {
      console.log("Reference frame data loaded");
    });
  }

  get imageryProviderNames(): string[] {
    return Object.keys(imageryProviders);
  }

  get baseLayers(): string[] {
    return baseLayerNames();
  }

  get overlayLayers(): string[] {
    return overlayLayerNames();
  }

  set imageryLayers(newLayerNames: string[]) {
    this.clearImageryLayers();
    newLayerNames.forEach((layerName) => {
      const selection = parseLayer(layerName);
      if (selection === undefined) {
        return;
      }
      const layer = this.createImageryLayer(selection.provider, selection.alpha);
      if (layer) {
        this.viewer.scene.imageryLayers.add(layer);
      }
    });
    // Providers resolve asynchronously, so without this render-on-demand never tiles
    // the new layer and the globe stays blank.
    this.viewer.scene.requestRender();
  }

  clearImageryLayers(): void {
    this.#imageryLifetime.abort();
    this.#imageryLifetime = new AbortController();
    this.viewer.scene.imageryLayers.removeAll();
  }

  createImageryLayer(imageryProviderName: string, alpha?: number): ImageryLayer | false {
    if (!this.imageryProviderNames.includes(imageryProviderName)) {
      console.error("Unknown imagery layer");
      return false;
    }

    const provider = imageryProviders[imageryProviderName] as ImageryProviderEntry;
    const context: ImageryContext = {
      clock: this.viewer.clock,
      requestRender: () => this.viewer.scene.requestRender(),
      signal: this.#imageryLifetime.signal,
    };
    const layer = ImageryLayer.fromProviderAsync(Promise.resolve(provider.create(context)), {});
    layer.alpha = alpha === undefined ? provider.alpha : alpha;
    return layer;
  }

  get terrainProviderNames(): string[] {
    return visibleTerrainProviderNames();
  }

  set terrainProvider(terrainProviderName: string) {
    if (!this.terrainProviderNames.includes(terrainProviderName)) {
      console.error("Unknown terrain provider");
      return;
    }
    this.terrain.choose(terrainProviderName);
  }

  /** The user's choice, not necessarily the one in force. */
  get terrainProvider(): string {
    return this.terrain.chosen;
  }

  /** Accepts any registered provider, including ones a url may not name. */
  suppressTerrain(terrainProviderName: string): void {
    if (!(terrainProviderName in terrainProviders)) {
      console.error("Unknown terrain provider override");
      return;
    }
    this.terrain.suppress(terrainProviderName);
  }

  releaseTerrain(): void {
    this.terrain.release();
  }

  /**
   * No "already applied" short-circuit. One that marked the name before the await
   * made a terrain host that hangs impossible to select again.
   */
  async #applyTerrain(name: string, isCurrent: () => boolean): Promise<void> {
    try {
      const provider = await (terrainProviders[name] as TerrainProviderEntry).create();
      if (!isCurrent()) {
        return;
      }
      // Measured before the swap, or the sky view's eye sits under the new ground for a beat.
      const observer = this.skyView.active ? this.skyView.observer : undefined;
      const groundHeight = observer ? await this.#terrainHeightAt(provider, observer) : undefined;
      if (!isCurrent()) {
        return;
      }
      this.viewer.terrainProvider = provider;
      if (groundHeight !== undefined) {
        this.skyView.setGroundHeight(groundHeight);
        // That height is the terrain's and discards a measurement in flight, such as the
        // roof under OSM Buildings, which brings World Terrain with it.
        if (this.surface.active) {
          this.skyView.remeasureGround();
        }
      }
    } catch (error) {
      // The previous terrain stays.
      console.error(`Terrain provider ${name} failed to load`, error);
    }
  }

  /**
   * Measured rather than read off `globe.getHeight`, which answers from whatever
   * tile has loaded, so the eye would jump as terrain streams.
   */
  async #observerGroundHeight(observer: Observer): Promise<number | undefined> {
    // Where the tileset has nothing, a street under OSM Buildings, the terrain answers.
    const surface = this.surface.active ? await this.surface.surfaceHeight(observer) : undefined;
    return surface ?? this.#terrainHeightAt(this.viewer.terrainProvider, observer);
  }

  /** The ellipsoid provider has no `availability`, and its height is 0 everywhere. */
  async #terrainHeightAt(provider: TerrainProvider, observer: Observer): Promise<number | undefined> {
    if (!provider.availability) {
      return 0;
    }
    try {
      const [sample] = await sampleTerrainMostDetailed(provider, [Cartographic.fromDegrees(observer.lon, observer.lat)]);
      return sample?.height;
    } catch (error) {
      console.warn("Could not sample the terrain under the observer", error);
      return undefined;
    }
  }

  async applySurfaceModel(surfaceModel: string, viewMode: string): Promise<void> {
    // On selection, not on load, with the view mode, so failed or inapplicable choices show up too.
    if (surfaceModel !== this.#selectedSurfaceModel) {
      this.#selectedSurfaceModel = surfaceModel;
      if (surfaceModel !== "None") {
        usePostHog().posthog.capture("surface_model_selected", { surface_model: surfaceModel, view_mode: viewMode });
      }
    }

    await this.surface.apply(surfaceModel, viewMode);
  }

  /** Only modes naming a Cesium `SceneMode`; sceneSync drives "Sky". */
  morphTo(sceneMode: string): void {
    const target = cesiumSceneMode(sceneMode);
    if (target === undefined) {
      console.error(`Unknown scene mode ${sceneMode}`);
      return;
    }

    // Cesium raises no `morphComplete` here, so suppressing would hide the batched
    // components for good (3D -> Sky -> 3D asks for the mode already in force).
    if (this.viewer.scene.mode === target) {
      return;
    }

    const morph = (): void => {
      if (target === SceneMode.SCENE3D) {
        this.viewer.scene.morphTo3D();
      } else if (target === SceneMode.SCENE2D) {
        this.viewer.scene.morphTo2D();
      } else {
        this.viewer.scene.morphToColumbusView();
      }
    };

    // In every direction, including back to 3D: outside 3D each batched component falls
    // back to per-entity paths, and only re-creation on release switches it back
    // (342 ms a frame vs 1.24 ms batched).
    const suppressed = BATCHED_COMPONENTS.filter((name) => this.sats.suppressComponent(name));
    if (suppressed.length > 0) {
      const release = (): void => {
        suppressed.forEach((name) => this.sats.releaseComponent(name));
        this.viewer.scene.morphComplete.removeEventListener(release);
      };
      this.viewer.scene.morphComplete.addEventListener(release);

      // Batches rebuild asynchronously; morphing first rebuilds them into the old projection.
      void Promise.all([this.sats.orbits.settled(), this.sats.tracks.settled()]).then(() => {
        morph();
        // Cesium refuses some morphs (mid-morph, notably) and then raises no completion.
        if (this.viewer.scene.mode !== SceneMode.MORPHING) {
          release();
        }
      });
    } else {
      morph();
    }
  }

  set cameraMode(cameraMode: string) {
    if (cameraMode !== "Inertial" && cameraMode !== "Fixed") {
      console.error("Unknown camera mode");
      return;
    }
    this.camera.choose(cameraMode);
  }

  /** The user's choice, not necessarily the one in force. */
  get cameraMode(): string {
    return this.camera.chosen;
  }

  /** The sky view drives the camera, and inertial tracking re-parents it every frame. */
  suppressCameraMode(): void {
    this.camera.suppress("Fixed");
  }

  releaseCameraMode(): void {
    this.camera.release();
  }

  #applyCameraMode(mode: string): void {
    const trackEci = mode === "Inertial";
    // Cesium's Event registers the same listener twice, so track the removal callback.
    if (trackEci && !this.#removeCameraTrackEci) {
      this.#removeCameraTrackEci = this.viewer.scene.postUpdate.addEventListener(this.cameraTrackEci);
    } else if (!trackEci && this.#removeCameraTrackEci) {
      this.#removeCameraTrackEci();
      this.#removeCameraTrackEci = undefined;
    }
  }

  cameraTrackEci(scene: Scene, time: JulianDate): void {
    if (scene.mode !== SceneMode.SCENE3D) {
      return;
    }

    const icrfToFixed = Transforms.computeIcrfToFixedMatrix(time);
    if (defined(icrfToFixed)) {
      const { camera } = scene;
      const offset = Cartesian3.clone(camera.position);
      const transform = Matrix4.fromRotationTranslation(icrfToFixed);
      camera.lookAtTransform(transform, offset);
    }
  }

  setTime(
    current: string | number | Date,
    start: string = dayjs.utc(current).subtract(12, "hour").toISOString(),
    stop: string = dayjs.utc(current).add(7, "day").toISOString(),
  ): void {
    this.viewer.clock.startTime = JulianDate.fromIso8601(dayjs.utc(start).toISOString());
    this.viewer.clock.stopTime = JulianDate.fromIso8601(dayjs.utc(stop).toISOString());
    this.viewer.clock.currentTime = JulianDate.fromIso8601(dayjs.utc(current).toISOString());
  }

  createInputHandler(): void {
    // The Viewer's own click handler selects what a click hits and clears the selection on a miss.
    const viewerHandler = this.viewer.screenSpaceEventHandler;
    const select = viewerHandler.getInputAction(ScreenSpaceEventType.LEFT_CLICK) as (event: ScreenSpaceEventHandler.PositionedEvent) => void;
    viewerHandler.setInputAction((event: ScreenSpaceEventHandler.PositionedEvent) => {
      if (this.#keepSelection && !defined(this.viewer.scene.pick(event.position))) {
        return;
      }
      select(event);
    }, ScreenSpaceEventType.LEFT_CLICK);

    const handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
    handler.setInputAction((event: ScreenSpaceEventHandler.PositionedEvent) => {
      const { pickMode } = useCesiumStore();
      if (!pickMode) {
        return;
      }
      this.setGroundStationFromClickEvent(event);
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  /**
   * The click being released keeps the selection if it hits nothing, and still selects what it hits. Cleared
   * once this event is over, because Cesium fires no click for a press that moved past its 5px tolerance.
   */
  keepSelectionOnEmptyClick(): void {
    this.#keepSelection = true;
    setTimeout(() => {
      this.#keepSelection = false;
    });
  }

  setGroundStationFromClickEvent(event: ScreenSpaceEventHandler.PositionedEvent): void {
    const cartesian = this.viewer.camera.pickEllipsoid(event.position);
    if (!defined(cartesian)) {
      return;
    }
    const cartographicPosition = Cartographic.fromCartesian(cartesian);
    this.addGroundStation(CesiumMath.toDegrees(cartographicPosition.latitude), CesiumMath.toDegrees(cartographicPosition.longitude));
    useCesiumStore().pickMode = false;
  }

  /** `observe` also makes the new station the sky view's observer. Whether a fix came back. */
  async setGroundStationFromGeolocation({ observe = false }: { observe?: boolean } = {}): Promise<boolean> {
    const fix = await currentPosition();
    if (!fix) {
      useToastProxy().add({
        title: "Location unavailable",
        description: "No position came back. Check this site's location permission, and note that geolocation needs a secure context.",
        color: "warning",
      });
      return false;
    }
    this.addGroundStation(fix.lat, fix.lon, "Geolocation", observe);
    return true;
  }

  setGroundStationFromLatLon(lat: number, lon: number): void {
    this.addGroundStation(lat, lon);
  }

  /**
   * sceneSync turns the store's ground stations into entities. Do not truth-test: 0 is a valid coordinate.
   */
  private addGroundStation(lat: number, lon: number, name = "", observe = false): void {
    const satStore = useSatStore();
    satStore.addGroundStation({ lat, lon, ...(name ? { name } : {}) }, { observe });
  }

  /** Cesium's own chrome is only the fullscreen button. */
  set showUI(enabled: boolean) {
    this.#uiVisible = enabled;
    const fullscreen = this.viewer._fullscreenButton?._container;
    if (fullscreen) {
      fullscreen.style.visibility = enabled ? "" : "hidden";
    }
  }

  get showUI(): boolean {
    return this.#uiVisible;
  }

  fixLogo(): void {
    if (this.minimalUI) {
      this.viewer._bottomContainer.style.left = "5px";
    }
    if (DeviceDetect.isiPhoneWithNotchVisible()) {
      this.viewer._bottomContainer.style.bottom = "20px";
    }
  }

  /**
   * Drawing-buffer pixels per CSS pixel (`PIXEL_RATIOS`). With
   * `useBrowserRecommendedResolution` false, Cesium multiplies by the display's
   * ratio. No explicit render: `CesiumWidget.resize` requests one every frame.
   */
  set pixelRatio(ratio: string) {
    if (!(PIXEL_RATIOS as readonly string[]).includes(ratio)) {
      console.error("Unknown pixel ratio");
      return;
    }
    this.viewer.useBrowserRecommendedResolution = false;
    this.viewer.resolutionScale = resolutionScaleFor(ratio, window.devicePixelRatio);
  }

  /** One of `MSAA_RATES`. Changing the sample count requests no frame, hence the explicit render. */
  set msaa(rate: string) {
    if (!(MSAA_RATES as readonly string[]).includes(rate)) {
      console.error("Unknown MSAA rate");
      return;
    }
    this.viewer.scene.msaaSamples = msaaSamplesFor(rate);
    this.viewer.scene.requestRender();
  }

  /**
   * Owned by the store: the Graphics panel and the benchmark panel both write it, and the
   * scene property is not reactive.
   */
  set requestRenderMode(value: boolean) {
    this.viewer.scene.requestRenderMode = value;
    // Switching it on otherwise looks like a freeze.
    this.viewer.scene.requestRender();
  }

  set showFps(value: boolean) {
    this.viewer.scene.debugShowFramesPerSecond = value;
  }

  /**
   * Rejects if the faces fail to fetch. Fetched here, not by Cesium: Cesium fetches
   * inside `Scene.render`, where a 404 (`DeepStar2K` is absent until
   * `pnpm update-starmap` runs) takes the app down via `rethrowRenderErrors`.
   * The viewer starts with the built-in sky box, so sceneSync's watcher is not immediate.
   */
  async applyStarMap(name: string): Promise<void> {
    if (!(STAR_MAPS as readonly string[]).includes(name)) {
      console.error("Unknown star map");
      return;
    }
    // `background: false` removed the sky box on purpose.
    if (!useCesiumStore().background) {
      return;
    }

    const generation = ++this.#starMapGeneration;
    const sources = starMapSources(name);
    const faces = sources === undefined ? undefined : await this.loadStarMapFaces(sources);
    if (generation !== this.#starMapGeneration) {
      return;
    }

    const previous = this.viewer.scene.skyBox;
    this.viewer.scene.skyBox = faces === undefined ? SkyBox.createEarthSkyBox() : new SkyBox({ sources: faces });
    // Scene destroys its sky box only with itself, so a swap leaks the old cube map
    // (100 MB for `DeepStar2K`, which Cesium keeps unmipmapped).
    previous?.destroy();
    // Nothing in Cesium requests a frame when a cube map lands.
    this.viewer.scene.requestRender();
  }

  /** Fetched as Cesium's `loadCubeMap` does; without `flipY` the sky is mirrored. */
  private async loadStarMapFaces(sources: StarMapSources): Promise<Record<keyof StarMapSources, ImageBitmap | HTMLImageElement>> {
    const entries = Object.entries(sources) as [keyof StarMapSources, string][];
    const images = await Promise.all(
      entries.map(async ([, url]) => {
        const image = await Resource.fetchImage({ url, flipY: true, preferImageBitmap: true });
        if (!image) {
          throw new Error(`Star map face ${url} did not load`);
        }
        return image;
      }),
    );
    return Object.fromEntries(entries.map(([face], index) => [face, images[index]])) as Record<keyof StarMapSources, ImageBitmap | HTMLImageElement>;
  }

  set background(active: boolean) {
    if (!active) {
      this.viewer.scene.backgroundColor = Color.TRANSPARENT;
      this.viewer.scene.moon = undefined;
      this.viewer.scene.skyAtmosphere = undefined;
      // Destroyed, not dropped: see `applyStarMap`.
      const skyBox = this.viewer.scene.skyBox;
      this.viewer.scene.skyBox = undefined;
      skyBox?.destroy();
      this.viewer.scene.sun = undefined;
      document.documentElement.style.background = "transparent";
      document.body.style.background = "transparent";
      const container = document.getElementById("cesiumContainer");
      if (container) container.style.background = "transparent";
    }
  }

  enablePerformanceStats(logContinuously = false): void {
    this.performanceStats = new CesiumPerformanceStats(this.viewer.scene, logContinuously);
  }

  addErrorHandler(): void {
    this.viewer.scene.rethrowRenderErrors = true;
    this.viewer.scene.renderError.addEventListener((scene: Scene, error: Error) => {
      console.error(scene, error);
      usePostHog().posthog.captureException(error);
    });

    // Cesium shows its panel for a render-loop error and goes no further, so wrap the panel.
    const widget = this.viewer.cesiumWidget;
    const proxied = widget.showErrorPanel;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    widget.showErrorPanel = function widgetError(this: unknown, title: string, message: string, error: any) {
      proxied.apply(this, [title, message, error]);
      usePostHog().posthog.captureException(reportableError(error, title, message));
    };
  }
}
