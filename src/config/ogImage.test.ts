// The link preview's version in the pages' og:image against the card
// (scripts/showcase/og-image.mjs), so a redrawn card is never shipped under the url the apps
// cached the old one by.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const root = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** The card's SHA-256, from its Git LFS pointer where the checkout has no LFS files, as CI's. */
function cardSha256(): string {
  const data = readFileSync(root("public/og-image.webp"));
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(data.subarray(0, 200).toString("latin1"));
  return oid?.[1] ?? createHash("sha256").update(data).digest("hex");
}

test("both pages name the card by its current version", () => {
  const version = cardSha256().slice(0, 8);
  for (const page of ["index.html", "about.html"]) {
    expect(readFileSync(root(page), "utf8"), page).toContain(`<meta property="og:image" content="https://satvis.space/og-image.webp?v=${version}" />`);
  }
});
