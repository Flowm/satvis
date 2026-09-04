// Which configuration each route opens with, and where its element sets come from.

// A source is either a bare GP group name (resolved against the probed GP base,
// worker `/api/gp/<name>.json` or the static `data/gp/<name>.json` snapshot) or
// an explicit URL/path (anything containing "/" or ".", incl. legacy .txt),
// which passes through unchanged and is parsed via payload sniffing.
//
// A search-only source still fills the catalog, so its satellites can be found
// and switched on one at a time, but its tags get no group row and no entry in
// the group multiselect: the group is too large to be worth enabling whole.
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

export const presets: Record<string, Preset> = {
  default: {
    title: "Satvis - 3D Satellite Tracker & Sky View",
    config: {
      sat: {
        enabledTags: ["Weather"],
      },
    },
    // Bare group names matching worker/src/config/satvis.core.yaml.
    //
    // `Active` is the whole CelesTrak active list, served in disjoint pieces:
    // the seven groups the worker carves out of it by name, plus
    // `active-remainder` for everything else. Tagging the pieces alike is what
    // makes them one group here, and what keeps a search or an Active
    // activation from downloading Starlink twice. A group added to the
    // remainder's exclude list needs the tag here too (worker/test/config.test.ts).
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
    elements: [
      ["ot", ["OT"]],
      ["wfs", ["WFS"]],
      ["active", ["Active"], { searchOnly: true }],
    ],
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
