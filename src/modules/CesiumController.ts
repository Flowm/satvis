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
import { parseLayer } from "../config/layers";
import { MSAA_RATES, PIXEL_RATIOS, msaaSamplesFor, resolutionScaleFor } from "../config/rendering";
import { STAR_MAPS, type StarMapSources, starMapSources } from "../config/starMaps";
import { CAMERA_MODES, SCENE_MODES } from "../config/viewModes";
import { useCesiumStore } from "../stores/cesium";
import { useSatStore } from "../stores/sat";
import {
  baseLayerNames,
  type ImageryProviderEntry,
  imageryProviders,
  overlayLayerNames,
  type TerrainProviderEntry,
  terrainProviders,
  terrainProviderNames as visibleTerrainProviderNames,
} from "./CesiumLayerProviders";
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
 * The components drawn into a shared polyline primitive rather than per entity,
 * and so the ones a scene morph has to suppress and wait out. See `sceneMode`.
 */
const BATCHED_COMPONENTS = ["Orbit", "Orbit track"] as const;

/**
 * Where the globe opens: Europe's meridian, a little north of the equator.
 *
 * Cesium's own default is `Rectangle.fromDegrees(-95, -20, -70, 90)`, a slice up
 * the Americas, which is why the camera used to start over the Carolinas.
 *
 * North of the equator rather than on it so that Europe is clear of the limb,
 * and only a little, because orbits culminate toward the equator and a view that
 * climbs much further north starts cutting off the southern hemisphere.
 */
const DEFAULT_VIEW_LON = 15;
const DEFAULT_VIEW_LAT = 25;

/**
 * How much of the screen's narrower axis the globe spans on opening. Under one so
 * the whole disc is in frame with room around it, rather than touching two edges.
 */
const DEFAULT_VIEW_FILL = 0.82;

/**
 * The value the error panel received, as an error worth a report.
 *
 * A provider that cannot get a tile gives a `RequestErrorEvent`, not an `Error`. It
 * has no message and no stack, so error tracking files it under the minified name of
 * the constructor. Each release then opens a new copy of the same unreadable issue.
 * The title and message from Cesium describe the error instead, and the original
 * value stays readable on the `cause`.
 */
export function reportableError(error: unknown, title: string, message?: string): Error {
  if (error instanceof Error) {
    return error;
  }
  const detail = [title, message].filter(Boolean).join(" — ");
  return new Error(`Cesium: ${detail || "render error"}`, { cause: error });
}

/**
 * Skip the frames that have no drawing buffer.
 *
 * The `_canRender` gate of Cesium reads the CSS box of the canvas, so it catches a
 * container that collapses. It does not catch a buffer that the browser withdraws
 * on a loss of context. The client size does not change then, so `resize` leaves
 * `_canRender` true. `Scene.render` takes a viewport of zero, `GlobeDepth` asks for
 * a texture of zero width, and the error panel stops the app until a reload.
 *
 * A skipped frame still ticks the clock, as Cesium does when `_canRender` is false.
 * `_renderRequested` holds any request until a frame draws.
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

  /** Whether the app's chrome is showing. See the `showUI` accessors. */
  #uiVisible: boolean = true;

  #removeCameraTrackEci: (() => void) | undefined;

  /**
   * The reference frame the camera is pinned to. Suppressed by the sky view,
   * which drives the camera itself — expressed as an override with "Fixed",
   * since that is what "do not track the inertial frame" means in force, while
   * the user's own choice stays untouched underneath.
   */
  readonly camera: Suppressible<string>;

  /** The terrain, which a surface model can insist on. See ADR-0005. */
  readonly terrain: Suppressible<string>;

  // The last surface model the store asked for, so the selection is reported once
  // rather than every time the view mode makes it re-apply.
  #selectedSurfaceModel: string | undefined;

  // Which `applyStarMap` call owns the sky box. Two switches in quick succession
  // race over a fetch, and the one that started last should win rather than the
  // one whose faces happen to arrive last.
  #starMapGeneration = 0;

  /**
   * Takes the viewer rather than making one (see src/modules/createViewer.ts).
   *
   * The constructor used to call `new Viewer("cesiumContainer", …)`, which meant
   * the class could not be brought into existence outside a browser and neither
   * could anything holding one. Everything here is now wiring: constructing the
   * managers and connecting them to each other, against a viewer that is
   * somebody else's problem to produce.
   */
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
      // Selecting by entity identity is all the info panel needs: it resolves
      // the selection itself off `viewer.selectedEntity`.
      onSelect: (target) => {
        this.viewer.selectedEntity = target.sat.defaultEntity;
      },
    });

    this.surface = new SurfaceModel({
      scene: this.viewer.scene,
      setTerrainOverride: (name) => (name === undefined ? this.releaseTerrain() : this.suppressTerrain(name)),
      skyLanded: () => this.skyView.settled,
      onFailure: (name, error) => {
        // The selection goes back to None so the radio, the url and the scene
        // cannot disagree — the same correction the imagery fallback makes — and
        // it is said out loud, because the commonest cause is a token this
        // origin is not allowed to use and nothing else would explain that.
        useCesiumStore().surfaceModel = "None";
        useToastProxy().add({
          title: `${name} unavailable`,
          description: `${error instanceof Error ? error.message : "The tileset could not be loaded"}. Cesium ion needs a token valid for this origin.`,
          color: "warning",
        });
      },
    });

    // Permanent, and asked again whenever what the observer stands on changes. The
    // sky view then has a measured height for every case — terrain, surface model,
    // bare ellipsoid — instead of following whichever tile has loaded so far.
    this.skyView.setGroundHeightSource((observer) => this.#observerGroundHeight(observer));

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
   * Open on the default view, far enough out that the whole globe is in frame.
   *
   * `Camera.DEFAULT_VIEW_RECTANGLE` — what Cesium places the camera by while
   * constructing the viewer, and what put it over the Americas — cannot express
   * this. It frames a *rectangle* in the current frustum, and Cesium's `fov` is
   * the horizontal angle on a landscape viewport and the vertical one otherwise,
   * so a single rectangle means very different distances on different shapes of
   * screen: the 25°-by-110° default lands at 12,700 km on a phone and 23,200 km on
   * a desktop window. On the phone that is not far enough. The globe spans 39° of
   * the 30° the narrow axis has to give and is clipped left and right — Cesium's
   * own default does this too, so the app has always been cutting the globe off
   * there.
   *
   * Framing the globe instead of a rectangle is one line of trigonometry and is
   * the same picture at every aspect ratio. Called after the viewer exists, which
   * is when there is a canvas to measure; Cesium has placed the camera once by
   * then, but no frame has been drawn, so there is nothing to see move.
   */
  setDefaultView(): void {
    const { camera, canvas, globe } = this.viewer.scene;
    if (!(camera.frustum instanceof PerspectiveFrustum) || camera.frustum.fov === undefined) {
      return;
    }
    const aspectRatio = canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 1;
    // Whichever angle Cesium is *not* reporting is the narrow one, by the rule
    // above — so the derived angle is always the one the globe has to fit inside.
    const { fov } = camera.frustum;
    const narrow = aspectRatio > 1 ? 2 * Math.atan(Math.tan(fov / 2) / aspectRatio) : 2 * Math.atan(Math.tan(fov / 2) * aspectRatio);
    // The equatorial radius, because that is the widest the disc can be.
    const radius = globe.ellipsoid.maximumRadius;
    const height = radius / Math.sin((narrow / 2) * DEFAULT_VIEW_FILL) - radius;
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
    // Providers resolve asynchronously — `fromUrl` fetches a manifest before the
    // layer exists — so the imagery lands after `requestRenderMode` has gone quiet,
    // and a globe whose imagery changed between frames is not something Cesium's
    // input handling can notice. Without this the new layer is never tiled and the
    // globe stays blank.
    this.viewer.scene.requestRender();
  }

  clearImageryLayers(): void {
    this.viewer.scene.imageryLayers.removeAll();
  }

  createImageryLayer(imageryProviderName: string, alpha?: number): ImageryLayer | false {
    if (!this.imageryProviderNames.includes(imageryProviderName)) {
      console.error("Unknown imagery layer");
      return false;
    }

    const provider = imageryProviders[imageryProviderName] as ImageryProviderEntry;
    const layer = ImageryLayer.fromProviderAsync(Promise.resolve(provider.create()), {});
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
    // Recorded but not applied while a surface model is imposing a terrain: this
    // is the choice that comes back on release, and building it now would only
    // fetch a provider nothing is going to show. `choose` is what knows that.
    this.terrain.choose(terrainProviderName);
  }

  /** The terrain the user picked, whether or not it is the one being drawn. */
  get terrainProvider(): string {
    return this.terrain.chosen;
  }

  /**
   * Impose a terrain over the user's choice. Suppression rather than a write, the
   * way the camera mode is suppressed: OSM Buildings needs the terrain it was
   * authored against, and the user's own terrain has to come back untouched the
   * moment it is deselected.
   *
   * Validated against every registered provider, not just the selectable ones, so
   * an override may name a terrain a url is not allowed to.
   */
  suppressTerrain(terrainProviderName: string): void {
    if (!(terrainProviderName in terrainProviders)) {
      console.error("Unknown terrain provider override");
      return;
    }
    this.terrain.suppress(terrainProviderName);
  }

  /** Honour the user's own terrain again. */
  releaseTerrain(): void {
    this.terrain.release();
  }

  /**
   * Build the terrain that is actually in force and hand it to the viewer.
   *
   * The staleness check is not ceremony: creating a provider is a fetch, and two
   * changes in quick succession — which is exactly what selecting a surface model
   * does, since it overrides the terrain in the same tick — can resolve out of
   * order and leave the loser applied. `isCurrent` is Suppressible's generation
   * guard; this used to be a counter kept here, and one of four written separately
   * across the codebase.
   *
   * Deliberately no "already applied" short-circuit. There was one, remembering the
   * name before awaiting the provider, and it turned a provider that never resolved
   * — a terrain host that hangs rather than refusing — into a terrain that could
   * never be selected again: the marker said applied, the viewer showed something
   * else, and every later request for it returned early. The callers already avoid
   * redundant work, so the only thing the marker bought was a way to lie.
   */
  async #applyTerrain(name: string, isCurrent: () => boolean): Promise<void> {
    try {
      const provider = await (terrainProviders[name] as TerrainProviderEntry).create();
      if (!isCurrent()) {
        return;
      }
      // Measured before the swap, not after: the sky view stands on this terrain, and
      // a height that arrives a beat later leaves the eye under the new ground for
      // that beat. Nothing is standing on it if the sky view is not up, so the
      // round trip is only spent when it buys something.
      const observer = this.skyView.active ? this.skyView.observer : undefined;
      const groundHeight = observer ? await this.#terrainHeightAt(provider, observer) : undefined;
      if (!isCurrent()) {
        return;
      }
      this.viewer.terrainProvider = provider;
      if (groundHeight !== undefined) {
        this.skyView.setGroundHeight(groundHeight);
      }
    } catch (error) {
      // Terrain can fail for a reason the network is not responsible for now that
      // one of them is ion-backed. The previous terrain stays, and the next
      // selection is free to try again.
      console.error(`Terrain provider ${name} failed to load`, error);
    }
  }

  /**
   * Put a surface model selection into effect, and tell the sky view what it is
   * now standing on.
   *
   * The two halves live together because the second is a consequence of the
   * first and neither module should have to know about the other: the surface
   * model can measure a height and the sky view needs one, and wiring them is
   * exactly what this class is for.
   */
  /**
   * What the observer is standing on, measured rather than guessed: the surface model
   * when one is drawing, otherwise the terrain in force.
   *
   * The sky view's own per-frame `globe.getHeight` is a fallback of last resort. It
   * answers from whatever tile happens to be loaded, so while terrain streams it
   * reports a coarse approximation, then a better one, then a better one — and the eye
   * follows each, which is a stagger of jumps rather than a move.
   */
  async #observerGroundHeight(observer: Observer): Promise<number | undefined> {
    if (this.surface.active) {
      return this.surface.surfaceHeight(observer);
    }
    return this.#terrainHeightAt(this.viewer.terrainProvider, observer);
  }

  /**
   * The height a given terrain provider puts under a point, at its most detailed.
   *
   * `sampleTerrainMostDetailed` needs the provider's availability metadata, which the
   * ellipsoid provider has none of because it does not need any: its surface is height
   * zero everywhere, and that is the answer rather than a missing one.
   */
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
    // On selection, not on load: what the quota is exposed to is people choosing
    // this, and a choice that fails or that lands in a view mode it cannot apply
    // in is exactly the kind of thing worth seeing. The view mode goes along so
    // the two are still distinguishable.
    if (surfaceModel !== this.#selectedSurfaceModel) {
      this.#selectedSurfaceModel = surfaceModel;
      if (surfaceModel !== "None") {
        usePostHog().posthog.capture("surface_model_selected", { surface_model: surfaceModel, view_mode: viewMode });
      }
    }

    const before = this.surface.active;
    await this.surface.apply(surfaceModel, viewMode);
    // Only on a change: what the observer stands on is the same as it was otherwise,
    // and re-measuring it is a needless round trip.
    if (this.surface.active !== before) {
      this.skyView.remeasureGround();
    }
  }

  /**
   * Switch the Cesium projection. Only the three view modes that name a Cesium
   * `SceneMode` come here — "Sky" is a camera placement rather than a
   * projection, and is driven from sceneSync because it needs an observer that
   * only the store can supply.
   */
  morphTo(sceneMode: string): void {
    const target = cesiumSceneMode(sceneMode);
    if (target === undefined) {
      console.error(`Unknown scene mode ${sceneMode}`);
      return;
    }

    // Already there, so there is nothing to morph and — the part that matters —
    // Cesium will not raise `morphComplete`. Returning here rather than below the
    // suppression is what keeps 3D → Sky → 3D working: the sky view renders in 3D,
    // so leaving it asks for a projection the scene is already in, and suppressing
    // against a completion that never comes would hide both batched components for
    // the life of the page.
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

    // Suppressed rather than disabled: the user still has these switched on and
    // the toolbar has to keep saying so through the morph. Asking the manager
    // whether it actually suppressed anything avoids reading back a value that
    // this call has already changed.
    //
    // Both batched components, not just Orbit: outside 3D each of them falls
    // back to a per-entity path graphic, and the only thing that re-asks the
    // question is a component being created again on release.
    //
    // This runs for every direction, including back to 3D. It used to return
    // before getting here, which left a round trip through 2D or Columbus drawing
    // every orbit as a per-entity path graphic once back in 3D — correct, and
    // measured at 342 ms a frame against 1.24 ms batched, because nothing re-asked
    // the question after the morph.
    const suppressed = BATCHED_COMPONENTS.filter((name) => this.sats.suppressComponent(name));
    if (suppressed.length > 0) {
      const release = (): void => {
        suppressed.forEach((name) => this.sats.releaseComponent(name));
        this.viewer.scene.morphComplete.removeEventListener(release);
      };
      this.viewer.scene.morphComplete.addEventListener(release);

      // Suppressing them drops every geometry from the shared batches, and a
      // batch rebuilds asynchronously — morphing before they have caught up
      // would rebuild them into the projection being left behind.
      void Promise.all([this.sats.orbits.settled(), this.sats.tracks.settled()]).then(() => {
        morph();
        // A morph that did not start raises no completion. The guard above catches
        // the reachable case, but Cesium refuses in others too — mid-morph, most
        // notably — and a suppression with no completion to release it is an empty
        // globe, so release now instead of trusting an event that may not come.
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

  /** The camera mode the user picked, whether or not it is being honoured. */
  get cameraMode(): string {
    return this.camera.chosen;
  }

  /**
   * Stop honouring the camera mode without changing it — the sky view drives
   * the camera itself, and inertial tracking re-parents it on every frame, so
   * the two cannot share it.
   *
   * Suppressed rather than forced back to Fixed: "Fixed" is what is in force, but
   * `camera.chosen` still says Inertial, so the toolbar keeps saying so, no history
   * entry is pushed for a change nobody asked for, and `?camera=Inertial` survives
   * the round trip.
   */
  suppressCameraMode(): void {
    this.camera.suppress("Fixed");
  }

  releaseCameraMode(): void {
    this.camera.release();
  }

  #applyCameraMode(mode: string): void {
    const trackEci = mode === "Inertial";
    // Tracked by its removal callback rather than by re-deriving it: Cesium's
    // Event happily registers the same listener twice, so asking for Inertial
    // while already inertial would otherwise stack a second one.
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
    const handler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);
    handler.setInputAction((event: ScreenSpaceEventHandler.PositionedEvent) => {
      const { pickMode } = useCesiumStore();
      if (!pickMode) {
        return;
      }
      this.setGroundStationFromClickEvent(event);
    }, ScreenSpaceEventType.LEFT_CLICK);
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

  /**
   * Through `currentPosition` rather than `navigator.geolocation` directly: this
   * used to pass no error callback at all, so a declined permission left the
   * button doing nothing, silently and forever.
   */
  async setGroundStationFromGeolocation(): Promise<void> {
    const fix = await currentPosition();
    if (!fix) {
      useToastProxy().add({
        title: "Location unavailable",
        description: "No position came back. Check this site's location permission, and note that geolocation needs a secure context.",
        color: "warning",
      });
      return;
    }
    this.addGroundStation(fix.lat, fix.lon, "Geolocation");
  }

  setGroundStationFromLatLon(lat: number, lon: number): void {
    this.addGroundStation(lat, lon);
  }

  // Ground stations are store state; the scene sync turns them into entities.
  // Note the coordinates are not truth-tested here: 0 is a real latitude, and
  // the filter that used to live downstream tested `lat && lon`, so it erased
  // any station on the equator or the Greenwich meridian.
  private addGroundStation(lat: number, lon: number, name = ""): void {
    const satStore = useSatStore();
    satStore.setGroundStations([...satStore.groundStations, { lat, lon, ...(name ? { name } : {}) }]);
  }

  /**
   * Cesium's own chrome, which is the fullscreen button and nothing else: no clock
   * widgets are built, and the deck places the credit line while it is up. The flag
   * is stored because no widget's `visibility` can be read back for it.
   */
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
   * Drawing-buffer pixels per CSS pixel — `1`, `1.25`, `1.5`, `1.75` or
   * `native` (`PIXEL_RATIOS`).
   *
   * `useBrowserRecommendedResolution` is held false throughout, which is what
   * makes Cesium multiply by the display's own ratio rather than by a flat 1.0;
   * the chosen ratio is then expressed as the `resolutionScale` that lands on
   * it. Leaving the flag alone and driving one number keeps the two from
   * disagreeing — the same picture used to be reachable two ways.
   *
   * No explicit render, unlike `msaa`. Both setters only raise Cesium's
   * `_forceResize` flag, but `CesiumWidget.resize` runs on every animation frame
   * ahead of `render` whatever render-on-demand is doing, and asks for a frame
   * itself once it has reconfigured the canvas.
   */
  set pixelRatio(ratio: string) {
    if (!(PIXEL_RATIOS as readonly string[]).includes(ratio)) {
      console.error("Unknown pixel ratio");
      return;
    }
    this.viewer.useBrowserRecommendedResolution = false;
    this.viewer.resolutionScale = resolutionScaleFor(ratio, window.devicePixelRatio);
  }

  /**
   * Multisample antialiasing — `off`, `2` or `4` (`MSAA_RATES`).
   *
   * Setting the sample count does not itself ask for a frame, so under
   * render-on-demand the control would appear to do nothing until something
   * else happened to request one — hence the explicit render.
   */
  set msaa(rate: string) {
    if (!(MSAA_RATES as readonly string[]).includes(rate)) {
      console.error("Unknown MSAA rate");
      return;
    }
    this.viewer.scene.msaaSamples = msaaSamplesFor(rate);
    this.viewer.scene.requestRender();
  }

  /**
   * Render-on-demand. Owned by the store rather than poked on the scene, because
   * more than one thing turns it off — the Render menu's switch and the benchmark panel —
   * and a plain scene property is not reactive, so a control bound straight to it
   * goes on showing the old value after anything else has written it.
   */
  set requestRenderMode(value: boolean) {
    this.viewer.scene.requestRenderMode = value;
    // One render either way. Switching render-on-demand *on* otherwise leaves
    // whatever was last drawn on screen until something happens to ask for a
    // frame, which makes the change look like a freeze.
    this.viewer.scene.requestRender();
  }

  set showFps(value: boolean) {
    this.viewer.scene.debugShowFramesPerSecond = value;
  }

  /**
   * Put a star map behind the globe — one of `STAR_MAPS`. Resolves once it is
   * drawing, and rejects if its faces could not be fetched.
   *
   * An action rather than a setter, unlike the rest of the scene settings,
   * because an optional map has to be in hand before the sky box is built.
   * Cesium is willing to take urls and fetch them itself, but it does that
   * *inside* the render loop: a face that 404s then throws out of `Scene.render`
   * rather than out of here, and with `rethrowRenderErrors` on that takes the app
   * down instead of falling back. Which is not hypothetical — `DeepStar2K` is
   * built by `pnpm update-starmap` and is absent until someone runs it.
   *
   * The viewer is constructed with exactly the built-in sky box (CesiumWidget
   * calls `SkyBox.createEarthSkyBox()` when it is passed none), so this only ever
   * runs to move off that or back to it — hence the watcher in sceneSync is not
   * immediate, and a link naming the built-in re-fetches nothing.
   */
  async applyStarMap(name: string): Promise<void> {
    if (!(STAR_MAPS as readonly string[]).includes(name)) {
      console.error("Unknown star map");
      return;
    }
    // A star map is part of the background, and `background: false` is what took
    // the sky box away. Installing one would put the stars back behind a scene
    // that asked to be transparent.
    if (!useCesiumStore().background) {
      return;
    }

    const generation = ++this.#starMapGeneration;
    const sources = starMapSources(name);
    const faces = sources === undefined ? undefined : await this.loadStarMapFaces(sources);
    // Overtaken while the faces were in flight. Nothing to undo — the swap below
    // is the only thing that touches the scene.
    if (generation !== this.#starMapGeneration) {
      return;
    }

    const previous = this.viewer.scene.skyBox;
    this.viewer.scene.skyBox = faces === undefined ? SkyBox.createEarthSkyBox() : new SkyBox({ sources: faces });
    // Scene destroys its sky box only when the scene itself goes, so a swap
    // without this leaks the outgoing cube map — 100 MB of it leaving
    // `DeepStar2K`, which Cesium keeps unmipmapped. Safe here because the scene
    // no longer holds the reference: the next frame builds its command from the
    // new one. Same reasoning in `set background`.
    previous?.destroy();
    // Nothing in Cesium asks for a frame when a cube map lands, so under
    // render-on-demand with a paused clock the swap would sit invisible.
    this.viewer.scene.requestRender();
  }

  /**
   * The six faces as images, fetched exactly the way Cesium's own `loadCubeMap`
   * would. The options are not incidental: `flipY` is what orients a cube map
   * face, and dropping it mirrors the sky.
   */
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
      // Destroyed, not merely dropped, for the reason `applyStarMap` gives: Scene
      // lets go of a sky box without freeing its cube map, which is up to 100 MB
      // once a 2048 map is the one being taken away.
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

    // Cesium answers a render-loop error by drawing its own panel and going no
    // further, so the only way these reach PostHog is to wrap the panel itself.
    const widget = this.viewer.cesiumWidget;
    const proxied = widget.showErrorPanel;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    widget.showErrorPanel = function widgetError(this: unknown, title: string, message: string, error: any) {
      proxied.apply(this, [title, message, error]);
      usePostHog().posthog.captureException(reportableError(error, title, message));
    };
  }
}
