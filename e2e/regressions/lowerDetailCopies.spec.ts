// A model with a lower-detail copy (ADR 0007) loaded its file even while drawn small,
// where the ISS's cost an iPad 3 ms of GPU a frame. The copy is drawn until the model
// grows or is tracked, and only then is the file fetched.

import { readFileSync } from "node:fs";

import { CUBE_MODEL, openApp } from "../support/app";
import { expect, test } from "../support/test";

const ISS = "ISS (ZARYA)";

const STATIONS = JSON.parse(readFileSync(new URL("../fixtures/gp/stations.json", import.meta.url), "utf8")) as { OBJECT_NAME: string; metadata?: Record<string, unknown> }[];

test("draws the copy at the default view and fetches the file once tracked", async ({ page }) => {
  const fetched: string[] = [];
  await openApp(page, `tags=&sats=${encodeURIComponent(ISS)}&elements=Point,Label,3D model`, {
    setup: async (setupPage) => {
      const stations = structuredClone(STATIONS);
      const iss = stations.find((record) => record.OBJECT_NAME === ISS)!;
      iss.metadata = { ...iss.metadata, model: { file: "ISS-(ZARYA).glb", lods: [{ file: "ISS-(ZARYA)-low.glb", maxPoints: 100 }] } };
      await setupPage.route("**/api/gp/stations.json", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(stations) }));
      await setupPage.route("**/data/models/*.glb", (route) => {
        fetched.push(decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!));
        return route.fulfill({ contentType: "model/gltf-binary", body: CUBE_MODEL });
      });
    },
  });
  const drawn = () =>
    page.evaluate((name) => {
      const sat = window.cc!.sats.activeSatellites.find((candidate) => candidate.props.name === name)!;
      return { state: sat.model.state(), level: sat.model.drawnLevel };
    }, ISS);

  await expect.poll(drawn, { message: "copy loaded" }).toEqual({ state: "ready", level: 1 });
  expect(fetched).toEqual(["ISS-(ZARYA)-low.glb"]);

  await page.evaluate((name) => window.cc!.sats.activeSatellites.find((sat) => sat.props.name === name)!.track(), ISS);
  await expect.poll(drawn, { message: "file drawn once tracked" }).toEqual({ state: "ready", level: 0 });
  expect(fetched).toEqual(["ISS-(ZARYA)-low.glb", "ISS-(ZARYA).glb"]);
});
