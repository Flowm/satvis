import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const APP_ID = "4L2672L4VX.org.frcy.app.satvis";

type Component = { "/"?: string; "?"?: string; comment?: string };
type Aasa = { applinks: { details: { appIDs: string[]; components: Component[] }[] } };

const aasa = JSON.parse(readFileSync(fileURLToPath(new URL("../../public/.well-known/apple-app-site-association", import.meta.url)), "utf8")) as Aasa;

// Apple's component patterns: `*` is zero or more characters, `?` exactly one.
function patternToRegExp(pattern: string) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "s");
}

function componentMatches(component: Component, url: URL) {
  const unsupported = Object.keys(component).filter((key) => !["/", "?", "comment"].includes(key));
  if (unsupported.length > 0) {
    throw new Error(`The matcher does not model ${unsupported.join(", ")}`);
  }
  if (component["?"] !== undefined && typeof component["?"] !== "string") {
    throw new Error("The matcher does not model the dictionary form of ?");
  }
  return patternToRegExp(component["/"] ?? "*").test(url.pathname) && patternToRegExp(component["?"] ?? "*").test(url.search.slice(1));
}

function opensApp(path: string) {
  const url = new URL(path, "https://satvis.space");
  return aasa.applinks.details.some((detail) => detail.appIDs.includes(APP_ID) && detail.components.some((component) => componentMatches(component, url)));
}

describe("apple-app-site-association", () => {
  test("claims only the satvis app, in the components form", () => {
    expect(Object.keys(aasa)).toEqual(["applinks"]);
    expect(aasa.applinks.details.map((detail) => detail.appIDs)).toEqual([[APP_ID]]);
    expect(aasa.applinks.details[0]).not.toHaveProperty("paths");
  });

  test.each([
    "/ot",
    "/ot?tags=OT",
    "/?tags=&sats=ISS+(ZARYA)&track=ISS+(ZARYA)&elements=Point,Label,Orbit&layers=VersaTiles",
    "/?time=2026-10-04T20:50Z",
    "/?gs=46.5935,7.9091&scene=Sky",
    "/?tags=",
    "/?utm_source=x",
  ])("%s opens the app", (path) => {
    expect(opensApp(path)).toBe(true);
  });

  test.each(["/", "/?", "/about", "/data/privacy.html", "/api/groups.json"])("%s stays on the web", (path) => {
    expect(opensApp(path)).toBe(false);
  });
});
