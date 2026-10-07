import { describe, expect, it } from "vitest";

import { isGcatBusName, modelsByBus } from "../src/gp/modelBuses.ts";

describe("modelsByBus", () => {
  it("maps each bus to its model, sorted", () => {
    const claims = [
      { bus: "Starlink V2M", modelFile: "STARLINK-V2-MINI.glb", origin: "models.yaml" },
      { bus: "Starlink", modelFile: "STARLINK-V1.glb", origin: "models.yaml" },
      { bus: "Starlink V2M", modelFile: "STARLINK-V2-MINI.glb", origin: "plugin/models.yaml" },
    ];
    expect(modelsByBus(claims)).toEqual({ Starlink: "STARLINK-V1.glb", "Starlink V2M": "STARLINK-V2-MINI.glb" });
  });

  it("fails on a bus two models claim, naming both", () => {
    const claims = [
      { bus: "Starlink V2M", modelFile: "STARLINK-V2-MINI.glb", origin: "models.yaml STARLINK-V2-MINI.glb" },
      { bus: "Starlink V2M", modelFile: "V2M.glb", origin: "plugin/models.yaml V2M.glb" },
    ];
    expect(() => modelsByBus(claims)).toThrow('bus "Starlink V2M" is claimed by models.yaml STARLINK-V2-MINI.glb and by plugin/models.yaml V2M.glb');
  });
});

describe("isGcatBusName", () => {
  it("takes GCAT's spelling only", () => {
    expect(isGcatBusName("Starlink V2M")).toBe(true);
    for (const bus of ["Starlink V2M ", " Starlink", "Starlink  V2M", "", 42, undefined]) {
      expect(isGcatBusName(bus)).toBe(false);
    }
  });
});
