// Which configuration each route opens with, and where its element sets come from.
//
// The presets and the tags of each group are defined in the worker's YAML config
// and served with the group index, so every client starts from the same ones
// (docs/adr/0007-native-ios-app.md).

import { fetchGpIndex } from "../modules/util/gpSource";
import type { Query } from "../modules/util/urlCodec";

// A source is either a bare GP group name (resolved against the probed GP base,
// worker `/api/gp/<name>.json` or the static `data/gp/<name>.json` snapshot) or
// an explicit URL/path (anything containing "/" or ".", incl. legacy .txt),
// which passes through unchanged and is parsed via payload sniffing.
//
// A search-only source fills the catalog like any other, but its tags get no
// group row and no multiselect entry: the group is too large to enable whole.
export type ElementsEntry = [source: string, tags: string[], options?: { searchOnly?: boolean }];

export interface Preset {
  name: string;
  title: string;
  description?: string;
  // Url parameters (docs/adr/0001-url-parameter-specification.md) that the url
  // only has to state deviations from.
  defaults: Query;
  elements: ElementsEntry[];
}

const DEFAULT_PRESET = "default";

// index.html carries the default preset's title, for crawlers that run no script.
// Read on first use, before updateMetadata replaces it.
let shellTitle: string | undefined;

// `/ot` and `/ot.html` open the `ot` preset; `/` and any path naming no preset
// open the default one.
export function presetNameOf(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.html$/, "") || DEFAULT_PRESET;
}

export async function resolvePreset(path: string = window.location.pathname): Promise<Preset> {
  shellTitle ??= document.title;
  const { groups, presets } = await fetchGpIndex();
  const requested = presetNameOf(path);
  const name = Object.hasOwn(presets, requested) ? requested : DEFAULT_PRESET;
  const preset = presets[name];
  if (preset === undefined) {
    console.warn("The group index carries no presets, so no groups are registered");
    return { name, title: shellTitle, defaults: {}, elements: [] };
  }

  const tagsOf = new Map(groups.map((group) => [group.name, group.tags ?? []]));
  return {
    name,
    title: preset.title ?? shellTitle,
    description: preset.description,
    defaults: preset.defaults ?? {},
    elements: preset.groups.map(({ name: group, searchOnly }): ElementsEntry => {
      const tags = tagsOf.get(group) ?? [];
      return searchOnly ? [group, tags, { searchOnly }] : [group, tags];
    }),
  };
}

export function updateMetadata(preset: Preset): void {
  document.title = preset.title;
  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription && preset.description) {
    metaDescription.setAttribute("content", preset.description);
  }
}
