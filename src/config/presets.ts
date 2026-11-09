// Which configuration each route opens with, and where its element sets come from.
//
// The presets and the tags of each group are defined in the worker's YAML config
// and served with the group index, so every client starts from the same ones.

import type { Bookmark } from "@/modules/util/bookmarks";
import { type BenchmarkScene, fetchGpIndex } from "@/modules/util/gpSource";
import type { Query } from "@/modules/util/urlCodec";

/**
 * A source is a GP group name, fetched from the probed GP base. A search-only source gets
 * no group row: it is too large to enable whole.
 */
export type ElementsEntry = [source: string, tags: string[], options?: { searchOnly?: boolean }];

export interface Preset {
  name: string;
  title: string;
  description?: string;
  /** Url parameters (ADR 0001); the url states only deviations. */
  defaults: Query;
  elements: ElementsEntry[];
  /** Its featured bookmarks, in the config's order (ADR 0011). */
  featured: Bookmark[];
  /** What the benchmark measures from this route, in the config's order (ADR 0016). */
  benchmarkScenes: BenchmarkScene[];
}

/** The preset of `/` and of any path naming no preset. */
export const DEFAULT_PRESET = "default";

/**
 * index.html carries the default preset's title, for crawlers that run no script.
 * Read on first use, before updateMetadata replaces it.
 */
let shellTitle: string | undefined;

/**
 * `/ot` and `/ot.html` open the `ot` preset; `/` and any path naming no preset
 * open the default one.
 */
export function presetNameOf(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.html$/, "") || DEFAULT_PRESET;
}

/** The path that opens preset `name`: `/` for the default one. */
export function presetPath(name: string): string {
  return name === DEFAULT_PRESET ? "/" : `/${name}`;
}

export async function resolvePreset(path: string = window.location.pathname): Promise<Preset> {
  shellTitle ??= document.title;
  const { groups, presets } = await fetchGpIndex();
  const requested = presetNameOf(path);
  const name = Object.hasOwn(presets, requested) ? requested : DEFAULT_PRESET;
  const preset = presets[name];
  if (preset === undefined) {
    console.warn("The group index carries no presets, so no groups are registered");
    return { name, title: shellTitle, defaults: {}, elements: [], featured: [], benchmarkScenes: [] };
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
    featured: (preset.featured ?? []).map(({ name: bookmarkName, thumbnail, query }, index): Bookmark => ({
      id: `featured-${name}-${index}`,
      kind: "featured",
      name: bookmarkName,
      path: presetPath(name),
      thumbnail,
      query,
      at: 0,
    })),
    benchmarkScenes: preset.benchmark ?? [],
  };
}

export function updateMetadata(preset: Preset): void {
  document.title = preset.title;
  const metaDescription = document.querySelector('meta[name="description"]');
  if (metaDescription && preset.description) {
    metaDescription.setAttribute("content", preset.description);
  }
}
