// Owns the surface model's tileset. src/config/surfaceModels.ts decides what a
// selection means; see docs/adr/0005-surface-models.md.

import { Cartesian3, Cartographic, type Cesium3DTileset, createGooglePhotorealistic3DTileset, createOsmBuildingsAsync, type Scene } from "@cesium/engine";

import { surfaceEffects, type SurfaceTileset } from "../config/surfaceModels";
import { SKY_MODE } from "../config/viewModes";
import type { Observer } from "./skyGeometry";
import { isPlausibleGroundHeight } from "./SkyView";
import { DeviceDetect } from "./util/DeviceDetect";

export interface SurfaceModelDeps {
  scene: Scene;
  /** `undefined` releases the override. */
  setTerrainOverride: (name: string | undefined) => void;
  onFailure: (name: SurfaceTileset, error: unknown) => void;
  /** The photorealistic mesh waits for the sky view to land rather than stream the whole descent. */
  skyLanded: () => boolean;
}

/** Cesium's defaults (1.5 GB cache plus 1 GB overflow) are sized for a desktop flying the globe. */
function googleTilesetOptions(): Cesium3DTileset.ConstructorOptions {
  // A coarse pointer catches Android; `inIframe` would not, and says nothing about memory.
  const constrained = DeviceDetect.isIos() || !DeviceDetect.canHover();
  return {
    cacheBytes: (constrained ? 192 : 512) * 1024 * 1024,
    maximumCacheOverflowBytes: (constrained ? 64 : 256) * 1024 * 1024,
    dynamicScreenSpaceError: true,
    // Above Cesium's 16: the mesh blurs rather than vanishes, unlike OSM Buildings.
    maximumScreenSpaceError: 24,
    // Skips the coarser ancestors, most of the bytes on a twenty-level tileset.
    skipLevelOfDetail: true,
    immediatelyLoadDesiredLevelOfDetail: true,
    // Google's Map Tiles policies ask for the attributions on screen, not behind Cesium's link.
    showCreditsOnScreen: true,
    // `enableCollision` stays at the helper's default `true`: with the globe hidden,
    // only the mesh stops the camera dropping through the ground.
  };
}

/**
 * Metres above the ground (not the ellipsoid, or La Paz never gets buildings) where
 * the globe hides OSM Buildings. `show = false` skips the traversal and every request.
 */
const GLOBE_BUILDING_CEILING = 1000;

/** Not beside the layer providers: a surface model is not one (see CONTEXT.md). */
const SURFACE_TILESETS: Record<SurfaceTileset, () => Promise<Cesium3DTileset>> = {
  // The default style colours each building from its `cesium#color` property.
  OsmBuildings: () => createOsmBuildingsAsync(),
  // Ion asset 2275207 via `Ion.defaultAccessToken`. `onlyUsingWithGoogleGeocoder` only
  // silences a console warning; this app has no geocoder.
  GooglePhotorealistic: () => createGooglePhotorealistic3DTileset({ onlyUsingWithGoogleGeocoder: true }, googleTilesetOptions()),
};

export class SurfaceModel {
  #deps: SurfaceModelDeps;

  #tileset: Cesium3DTileset | undefined;

  #name: SurfaceTileset | undefined;

  /** Guards the async creation against a newer `apply`. */
  #generation = 0;

  /** Asked per frame; undefined means always shown. */
  #gate: (() => boolean) | undefined;

  #removeGateWatch: (() => void) | undefined;

  #hideGlobe = false;

  /** The last plausible ground height under the camera, in metres. */
  #groundHeight = 0;

  constructor(deps: SurfaceModelDeps) {
    this.#deps = deps;
  }

  get active(): SurfaceTileset | undefined {
    return this.#name;
  }

  /** Idempotent. Call it when either argument changes. */
  async apply(surfaceModel: string, viewMode: string): Promise<void> {
    const effects = surfaceEffects(surfaceModel, viewMode);
    const generation = ++this.#generation;

    this.#hideGlobe = effects.hideGlobe;
    this.#deps.setTerrainOverride(effects.terrain);

    if (effects.tileset === this.#name) {
      // The view mode can still have changed.
      this.#syncGlobe();
      this.#tuneForViewMode(viewMode);
      return;
    }

    this.#remove();
    if (!effects.tileset) {
      this.#syncGlobe();
      return;
    }

    // Keep the globe until the tileset arrives.
    const tileset = await this.#create(effects.tileset);
    if (generation !== this.#generation) {
      tileset?.destroy();
      return;
    }
    if (!tileset) {
      this.#syncGlobe();
      return;
    }

    this.#tileset = tileset;
    this.#name = effects.tileset;
    this.#deps.scene.primitives.add(tileset);
    this.#watchTileFailures(tileset, effects.tileset);
    this.#syncGlobe();
    this.#tuneForViewMode(viewMode);
    // Without this, render-on-demand never traverses the new tileset.
    this.#deps.scene.requestRender();
  }

  /**
   * How far OSM Buildings refine around the observer. The photorealistic mesh is the
   * ground itself, so it is only gated, never capped.
   *
   * The reduction at distance d is `factor * (1 - exp(-(d * density)^2))`, and refinement
   * stops at `maximumScreenSpaceError` (16). Cesium's defaults (2.0e-4, 24) refine to
   * 5.2 km; the sky view's (8.0e-4, 48) to about 800 m. OSM Buildings refines
   * additively, so beyond that buildings are absent, not coarse.
   */
  #tuneForViewMode(viewMode: string): void {
    const tileset = this.#tileset;
    if (!tileset) {
      return;
    }
    if (this.#name === "GooglePhotorealistic") {
      this.#setGate(() => this.#deps.skyLanded());
      return;
    }
    if (this.#name !== "OsmBuildings") {
      return;
    }
    const onTheGround = viewMode === SKY_MODE;
    tileset.dynamicScreenSpaceErrorDensity = onTheGround ? 8.0e-4 : 2.0e-4;
    tileset.dynamicScreenSpaceErrorFactor = onTheGround ? 48 : 24;
    this.#setGate(onTheGround ? undefined : () => this.#heightAboveGround() < GLOBE_BUILDING_CEILING);
  }

  /** While terrain streams, `getHeight` can return nothing or nonsense (-76594 seen), so keep the last plausible one. */
  #heightAboveGround(): number {
    const cartographic = this.#deps.scene.camera.positionCartographic;
    const measured = this.#deps.scene.globe.getHeight(cartographic);
    if (isPlausibleGroundHeight(measured)) {
      this.#groundHeight = measured;
    }
    return cartographic.height - this.#groundHeight;
  }

  /** A `preRender` listener: no store holds the camera height or the flight's arrival. */
  #setGate(gate: (() => boolean) | undefined): void {
    this.#gate = gate;
    if (gate === undefined) {
      this.#removeGateWatch?.();
      this.#removeGateWatch = undefined;
      if (this.#tileset) {
        this.#tileset.show = true;
      }
      this.#syncGlobe();
      return;
    }
    this.#applyGate();
    this.#removeGateWatch ??= this.#deps.scene.preRender.addEventListener(() => this.#applyGate());
  }

  #applyGate(): void {
    const tileset = this.#tileset;
    const gate = this.#gate;
    if (!tileset || !gate) {
      return;
    }
    const show = gate();
    if (tileset.show !== show) {
      tileset.show = show;
      // The globe stands in while the tileset is withheld.
      this.#syncGlobe();
      this.#deps.scene.requestRender();
    }
  }

  /**
   * Undefined without a model, clamp support or geometry there. Clamps to the top,
   * so a building gives its roof (ADR 0005).
   */
  async surfaceHeight(observer: Observer): Promise<number | undefined> {
    const { scene } = this.#deps;
    const tileset = this.#tileset;
    if (!tileset || !scene.clampToHeightSupported) {
      return undefined;
    }
    const [clamped] = await scene.clampToHeightMostDetailed([Cartesian3.fromDegrees(observer.lon, observer.lat, 0)]);
    // Not `#generation`: a no-op re-apply must not discard the measurement.
    if (this.#tileset !== tileset || !clamped) {
      return undefined;
    }
    return Cartographic.fromCartesian(clamped).height;
  }

  /** Logs only the first failure: an exhausted quota mid-session looks like this. */
  #watchTileFailures(tileset: Cesium3DTileset, name: SurfaceTileset): void {
    let reported = false;
    tileset.tileFailed.addEventListener((error: { url?: string; message?: string }) => {
      if (reported) {
        return;
      }
      reported = true;
      console.warn(`Surface model ${name} failed to load a tile, and further tile failures will not be reported`, error.url, error.message);
    });
  }

  async #create(name: SurfaceTileset): Promise<Cesium3DTileset | undefined> {
    try {
      return await SURFACE_TILESETS[name]();
    } catch (error) {
      console.error(`Surface model ${name} failed to load`, error);
      this.#deps.onFailure(name, error);
      return undefined;
    }
  }

  #remove(): void {
    const tileset = this.#tileset;
    this.#tileset = undefined;
    this.#name = undefined;
    this.#removeGateWatch?.();
    this.#removeGateWatch = undefined;
    this.#gate = undefined;
    if (tileset) {
      // `remove` destroys it, releasing its tile cache.
      this.#deps.scene.primitives.remove(tileset);
      this.#deps.scene.requestRender();
    }
  }

  /** Asks the tileset, not the selection, so a failed, pending or withheld model leaves the globe up. */
  #syncGlobe(): void {
    const standingIn = this.#hideGlobe && this.#tileset !== undefined && this.#tileset.show;
    const { globe } = this.#deps.scene;
    if (globe.show !== !standingIn) {
      globe.show = !standingIn;
      this.#deps.scene.requestRender();
    }
  }
}
