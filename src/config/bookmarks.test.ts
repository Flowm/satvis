import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { DEMO_BOOKMARKS } from "./bookmarks";

const root = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

test("every demo is live and shows whole groups", () => {
  for (const demo of DEMO_BOOKMARKS) {
    expect(demo.query, demo.name).not.toHaveProperty("time");
    expect(demo.query, demo.name).not.toHaveProperty("sats");
    expect(demo.query, demo.name).not.toHaveProperty("xsats");
  }
});

test("every demo has its card picture", () => {
  for (const demo of DEMO_BOOKMARKS) {
    expect(existsSync(root(`public/${demo.thumbnail}`)), demo.thumbnail).toBe(true);
  }
});
