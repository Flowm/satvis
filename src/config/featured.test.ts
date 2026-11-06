// The featured bookmarks of the core config's presets (ADR 0011), against the url codec and the
// about page's copy of the default preset's.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createPinia, setActivePinia } from "pinia";
import { expect, test } from "vitest";
import { createApp } from "vue";
import { parse } from "yaml";

import { summarize } from "@/modules/util/bookmarks";
import { type FieldSpec, paramOf, type Query } from "@/modules/util/urlCodec";
import { useCesiumStore } from "@/stores/cesium";
import { useSatStore } from "@/stores/sat";

const root = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

interface CorePreset {
  name: string;
  defaults?: Query;
  featured?: { name: string; thumbnail: string; query?: Record<string, string> }[];
}

const presets = (parse(readFileSync(root("worker/src/config/satvis.core.yaml"), "utf8")) as { presets: CorePreset[] }).presets;
const featured = presets.flatMap((preset) => (preset.featured ?? []).map(({ name, thumbnail, query = {} }) => ({ preset: preset.name, name, thumbnail, query })));
const defaultPreset = presets.find(({ name }) => name === "default")!;

test("every featured bookmark is live and shows a group or a single satellite, never a list", () => {
  for (const bookmark of featured) {
    expect(bookmark.query, bookmark.name).not.toHaveProperty("time");
    expect(bookmark.query, bookmark.name).not.toHaveProperty("xsats");
    expect(bookmark.query.sats?.split(",").length ?? 0, bookmark.name).toBeLessThanOrEqual(1);
  }
});

// The iOS releases before featured bookmarks (2.0) fetch their bundled demos' pictures from the
// site by these paths. Nothing retakes them.
test("the JPEG cards the iOS app's older releases fetch stay on the site", () => {
  for (const name of ["globe", "iss", "sky"]) {
    expect(existsSync(root(`public/showcase/${name}-card.jpg`)), name).toBe(true);
  }
});

test("every featured bookmark has its card picture", () => {
  for (const bookmark of featured) {
    expect(existsSync(root(`public/${bookmark.thumbnail}`)), bookmark.thumbnail).toBe(true);
  }
});

// The worker cannot check these: it has no codec, and the stores own the vocabularies.
test("every featured bookmark's query reads back as written", () => {
  const schema: FieldSpec[] = [];
  const pinia = createPinia();
  pinia.use(({ options }) => void schema.push(...(options.urlsync?.config ?? [])));
  // Pinia installs plugins only once it has an app.
  createApp({}).use(pinia);
  setActivePinia(pinia);
  useSatStore();
  useCesiumStore();
  const byParam = new Map(schema.map((spec) => [paramOf(spec), spec.kind]));

  for (const bookmark of featured) {
    for (const [param, raw] of Object.entries(bookmark.query)) {
      const kind = byParam.get(param);
      expect(kind, `${bookmark.name}: ${param}`).toBeDefined();
      const parsed = kind!.parse(raw);
      expect(parsed.ok && kind!.format(parsed.value), `${bookmark.name}: ${param}`).toEqual({ ok: true, value: raw });
    }
  }
});

test("the about page shows the default preset's featured bookmarks as their cards do, and links to them", () => {
  const shown = featured.filter(({ preset }) => preset === "default");
  const html = readFileSync(root("about.html"), "utf8");
  const text = (markup: string): string =>
    markup
      .replace(/<[^>]*>/g, "")
      .replaceAll("&amp;", "&")
      .replace(/\s+/g, " ")
      .trim();
  const slides = [...html.matchAll(/<li class="featuredCarousel__slide"[^>]*aria-label="([^"]*)"[^>]*>([\s\S]*?)<\/li>/g)].map(([, label, slide]) => ({
    label,
    href: /href="([^"]*)"/.exec(slide!)![1]!.replaceAll("&amp;", "&"),
    src: /src="([^"]*)"/.exec(slide!)![1],
    // The formatter may wrap a tag's closing `>` onto the next line.
    name: text(/<span class="featuredCarousel__name"\s*>([\s\S]*?)<\/span\s*>/.exec(slide!)![1]!),
    facts: [...slide!.matchAll(/<span class="featuredCarousel__fact"\s*>([\s\S]*?)<\/span\s*>/g)].map(([, fact]) => text(fact!)),
  }));

  expect(slides).toHaveLength(shown.length);
  shown.forEach((bookmark, index) => {
    const slide = slides[index]!;
    const url = new URL(slide.href, "https://satvis.space");
    const { what, where } = summarize(bookmark.query, defaultPreset.defaults ?? {});
    expect(slide.label).toBe(`${index + 1} of ${shown.length}`);
    expect(url.pathname, bookmark.name).toBe("/");
    expect(Object.fromEntries(url.searchParams), bookmark.name).toEqual(bookmark.query);
    expect(slide.src, bookmark.name).toBe(`/${bookmark.thumbnail}`);
    expect(slide.name).toBe(bookmark.name);
    expect(slide.facts, bookmark.name).toEqual([what, where]);
  });
});
