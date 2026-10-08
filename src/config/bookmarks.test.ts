import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { sameQuery } from "../modules/util/bookmarks";
import { DEMO_BOOKMARKS } from "./bookmarks";

const root = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** The links of the about page's showcase, in page order, once each. */
function showcaseLinks(): Record<string, string>[] {
  const html = readFileSync(root("about.html"), "utf8");
  const showcase = html.slice(html.indexOf('class="about-showcase"'));
  const hrefs = [...showcase.matchAll(/<a\s+href="(\/\?[^"]+)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
  return [...new Set(hrefs)].map((href) => Object.fromEntries(new URLSearchParams(href.slice(2))));
}

test("the demos are the about page's showcase links", () => {
  const links = showcaseLinks();
  expect(links).toHaveLength(DEMO_BOOKMARKS.length);
  for (const [index, demo] of DEMO_BOOKMARKS.entries()) {
    expect(sameQuery(demo.query, links[index]!), demo.name).toBe(true);
  }
});

test("every demo has its card picture", () => {
  for (const demo of DEMO_BOOKMARKS) {
    expect(existsSync(root(`public/${demo.thumbnail}`)), demo.thumbnail).toBe(true);
  }
});
