import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";
import { parse } from "yaml";

import { summarize } from "../modules/util/bookmarks";
import type { Query } from "../modules/util/urlCodec";
import { DEMO_BOOKMARKS } from "./bookmarks";

const root = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

test("every demo is live and shows a group or a single satellite, never a list", () => {
  for (const demo of DEMO_BOOKMARKS) {
    expect(demo.query, demo.name).not.toHaveProperty("time");
    expect(demo.query, demo.name).not.toHaveProperty("xsats");
    expect(demo.query.sats?.split(",").length ?? 0, demo.name).toBeLessThanOrEqual(1);
  }
});

test("every demo has its card picture", () => {
  for (const demo of DEMO_BOOKMARKS) {
    expect(existsSync(root(`public/${demo.thumbnail}`)), demo.thumbnail).toBe(true);
  }
});

test("the about page shows the demos as their cards do, and links to them", () => {
  const presets = (parse(readFileSync(root("worker/src/config/satvis.core.yaml"), "utf8")) as { presets: { name: string; defaults?: Query }[] }).presets;
  const defaults = presets.find(({ name }) => name === "default")?.defaults ?? {};
  const html = readFileSync(root("about.html"), "utf8");
  const text = (markup: string): string =>
    markup
      .replace(/<[^>]*>/g, "")
      .replaceAll("&amp;", "&")
      .replace(/\s+/g, " ")
      .trim();
  const slides = [...html.matchAll(/<li class="demoCarousel__slide"[^>]*aria-label="([^"]*)"[^>]*>([\s\S]*?)<\/li>/g)].map(([, label, slide]) => ({
    label,
    href: /href="([^"]*)"/.exec(slide!)![1]!.replaceAll("&amp;", "&"),
    demo: /data-demo="([^"]*)"/.exec(slide!)![1],
    src: /src="([^"]*)"/.exec(slide!)![1],
    // The formatter may wrap a tag's closing `>` onto the next line.
    name: text(/<span class="demoCarousel__name"\s*>([\s\S]*?)<\/span\s*>/.exec(slide!)![1]!),
    facts: [...slide!.matchAll(/<span class="demoCarousel__fact"\s*>([\s\S]*?)<\/span\s*>/g)].map(([, fact]) => text(fact!)),
  }));
  const dots = /<span class="demoCarousel__dots"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/.exec(html)![1]!.match(/<span>/g)?.length;

  expect(slides.map(({ demo }) => demo)).toEqual(DEMO_BOOKMARKS.map(({ id }) => id));
  expect(dots).toBe(DEMO_BOOKMARKS.length);
  DEMO_BOOKMARKS.forEach((demo, index) => {
    const slide = slides[index]!;
    const url = new URL(slide.href, "https://satvis.space");
    const { what, where } = summarize(demo.query, defaults);
    expect(slide.label).toBe(`${index + 1} of ${DEMO_BOOKMARKS.length}`);
    expect(url.pathname, demo.name).toBe(demo.path);
    expect(Object.fromEntries(url.searchParams), demo.name).toEqual(demo.query);
    expect(slide.src, demo.name).toBe(`/${demo.thumbnail}`);
    expect(slide.name).toBe(demo.name);
    expect(slide.facts, demo.name).toEqual([what, where]);
  });
});
