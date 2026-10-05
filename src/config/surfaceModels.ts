// The surface model vocabulary and every consequence of picking one, Cesium-free so the
// url schema, the Map menu and SurfaceModel share it. OsmBuildings adds to the globe;
// GooglePhotorealistic replaces it. See ADR 0005.

import { SKY_MODE } from "./viewModes";

export const SURFACE_MODELS = ["None", "OsmBuildings", "GooglePhotorealistic"] as const;
// Not `SurfaceModel`: that is the class in src/modules/SurfaceModel.ts.
export type SurfaceModelName = (typeof SURFACE_MODELS)[number];

export type SurfaceTileset = Exclude<SurfaceModelName, "None">;

/** Map menu groups a surface model can make inert. */
export type MapGroup = "layers" | "terrain";

interface SurfaceModelRules {
  /**
   * GooglePhotorealistic is sky-only to bound tile cost, not for a technical reason.
   * Cesium would draw tilesets in 2D and Columbus, but the result reads as broken.
   */
  viewModes: readonly string[];
  hidesGlobe: boolean;
  /** Forced while the model is up, because its heights assume it. */
  terrain?: string;
}

const RULES: Record<SurfaceModelName, SurfaceModelRules> = {
  None: {
    viewModes: ["3D", "2D", "Columbus", SKY_MODE],
    hidesGlobe: false,
  },
  OsmBuildings: {
    viewModes: ["3D", SKY_MODE],
    hidesGlobe: false,
    // Cesium cannot ground-clamp a tileset, so other terrain leaves the buildings floating or buried.
    terrain: "CesiumWorldTerrain",
  },
  GooglePhotorealistic: {
    viewModes: [SKY_MODE],
    hidesGlobe: true,
  },
};

export interface SurfaceEffects {
  tileset: SurfaceTileset | undefined;
  hideGlobe: boolean;
  /** Overrides the user's terrain; undefined honours it. */
  terrain: string | undefined;
  inert: readonly MapGroup[];
  /** Annotated, not disabled, so `?surface=GooglePhotorealistic&scene=Sky` works. */
  unavailable: readonly SurfaceModelName[];
}

export function isSurfaceModelName(value: string): value is SurfaceModelName {
  return (SURFACE_MODELS as readonly string[]).includes(value);
}

/** Total in both arguments, so the menu's annotations cannot drift from the scene. */
export function surfaceEffects(surfaceModel: string, viewMode: string): SurfaceEffects {
  const unavailable = SURFACE_MODELS.filter((name) => !RULES[name].viewModes.includes(viewMode));
  const selected: SurfaceModelName = isSurfaceModelName(surfaceModel) ? surfaceModel : "None";
  const rules = RULES[selected];
  // Suppressed, never deselected: the store and the url keep an unavailable model.
  const active = selected !== "None" && rules.viewModes.includes(viewMode);
  if (!active) {
    return { tileset: undefined, hideGlobe: false, terrain: undefined, inert: [], unavailable };
  }

  const inert: MapGroup[] = [];
  if (rules.hidesGlobe) {
    inert.push("layers", "terrain");
  } else if (rules.terrain !== undefined) {
    inert.push("terrain");
  }
  return {
    tileset: selected as SurfaceTileset,
    hideGlobe: rules.hidesGlobe,
    terrain: rules.terrain,
    inert,
    unavailable,
  };
}

/** A view mode's name in prose, where it differs. */
const VIEW_MODE_PROSE: Record<string, string> = { [SKY_MODE]: "sky" };

/** Derived from `viewModes`, so widening them cannot leave a stale sentence in the menu. */
export function viewModeNote(surfaceModel: string): string {
  if (!isSurfaceModelName(surfaceModel)) {
    return "";
  }
  const modes = RULES[surfaceModel].viewModes.map((mode) => VIEW_MODE_PROSE[mode] ?? mode);
  if (modes.length === 0) {
    return "Applies in no view mode";
  }
  const last = modes[modes.length - 1] as string;
  const list = modes.length === 1 ? last : `${modes.slice(0, -1).join(", ")} and ${last}`;
  return `Applies in the ${list} view${modes.length === 1 ? "" : "s"} only`;
}

// No name accessor, unlike imagery and terrain: every surface model is selectable.
