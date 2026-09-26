// Which configuration each route opens with, and where its element sets come from.

// A source is either a bare GP group name (resolved against the probed GP base,
// worker `/api/gp/<name>.json` or the static `data/gp/<name>.json` snapshot) or
// an explicit URL/path (anything containing "/" or ".", incl. legacy .txt),
// which passes through unchanged and is parsed via payload sniffing.
//
// A search-only source fills the catalog like any other, but its tags get no
// group row and no multiselect entry: the group is too large to enable whole.
export type ElementsEntry = [source: string, tags: string[], options?: { searchOnly?: boolean }];

export interface PresetConfig {
  sat?: {
    enabledTags?: string[];
    enabledComponents?: string[];
    overpassMode?: string;
  };
  cesium?: {
    layers?: string[];
    // One of SCENE_MODES. No preset sets it yet; it is here so that a route can
    // open straight into the sky view without the type having to change first,
    // which is the point of a preset supplying defaults.
    sceneMode?: string;
    // One of SURFACE_MODELS, and unset for the same reason: a route that opens on
    // the sky view is the one that would want buildings with it.
    surfaceModel?: string;
  };
}

export interface Preset {
  title: string;
  description?: string;
  config: PresetConfig;
  elements: ElementsEntry[];
}

// The CelesTrak active list as the worker serves it: seven groups carved out by
// name plus the remainder (worker/src/config/satvis.core.yaml). Under one tag
// they load as a whole, and no satellite arrives twice.
const ACTIVE_PIECES = ["globalstar", "iridium-NEXT", "oneweb", "planet", "spire", "starlink", "eutelsat", "active-remainder"];

export const presets: Record<string, Preset> = {
  default: {
    title: "Satvis - 3D Satellite Tracker & Sky View",
    config: {
      sat: {
        enabledTags: ["Weather"],
      },
    },
    // Bare group names matching worker/src/config/satvis.core.yaml. Every one
    // of ACTIVE_PIECES carries `Active` (checked by worker/test/config.test.ts).
    elements: [
      ["cubesat", ["Cubesat"]],
      ["globalstar", ["Globalstar", "Active"]],
      ["gnss", ["GNSS"]],
      ["iridium-NEXT", ["IridiumNEXT", "Active"]],
      ["last-30-days", ["New"]],
      ["oneweb", ["OneWeb", "Active"]],
      ["planet", ["Planet", "Active"]],
      ["resource", ["Resource"]],
      ["science", ["Science"]],
      ["spire", ["Spire", "Active"]],
      ["starlink", ["Starlink", "Active"]],
      ["stations", ["Stations"]],
      ["weather", ["Weather"]],
      ["eutelsat", ["Eutelsat", "Active"]],
      ["active-remainder", ["Active"]],
    ],
  },
  ot: {
    title: "OT Satvis - 3D Satellite Tracker & Sky View",
    config: {
      sat: {
        enabledTags: ["OT"],
        enabledComponents: ["Point", "Label", "Orbit", "Sensor cone", "Ground track"],
        overpassMode: "swath",
      },
      cesium: {
        layers: ["VersaTiles"],
      },
    },
    elements: [["ot", ["OT"]], ["wfs", ["WFS"]], ...ACTIVE_PIECES.map((source): ElementsEntry => [source, ["Active"], { searchOnly: true }])],
  },
};

export function getConfigPreset(path: string = window.location.pathname): Preset {
  const routeName = (path.split("/").pop() ?? "").replace(/\.html$/, "");

  switch (routeName) {
    case "ot":
      return presets.ot as Preset;
    default:
      return presets.default as Preset;
  }
}

export function updateMetadata(preset: Preset): void {
  document.title = preset.title;
  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription && preset.description) {
    metaDescription.setAttribute("content", preset.description);
  }
}
