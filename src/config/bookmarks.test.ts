import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

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
