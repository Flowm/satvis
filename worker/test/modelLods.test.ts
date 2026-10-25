import { describe, expect, it } from "vitest";

import { modelLodsByFile, parseModelLods } from "../src/gp/modelLods.ts";

describe("parseModelLods", () => {
  it("keeps each copy's file and maxPoints, not its measurements", () => {
    const lods = [{ file: "ISS-low.glb", maxPoints: 100, measured: { triangles: 42109 } }];
    expect(parseModelLods(lods, "models.yaml: ISS.glb")).toEqual([{ file: "ISS-low.glb", maxPoints: 100 }]);
    expect(parseModelLods(undefined, "models.yaml: ISS.glb")).toEqual([]);
  });

  it("fails on a path outside /data/models/ or a maxPoints that does not fall", () => {
    expect(() => parseModelLods([{ file: "../ISS-low.glb", maxPoints: 100 }], "m")).toThrow("lods[0].file must be a .glb path");
    expect(() => parseModelLods([{ file: "a.glb", maxPoints: 0 }], "m")).toThrow("lods[0].maxPoints must be positive");
    expect(() =>
      parseModelLods(
        [
          { file: "a.glb", maxPoints: 100 },
          { file: "b.glb", maxPoints: 100 },
        ],
        "m",
      ),
    ).toThrow("lods[1].maxPoints must be positive and below the one before it");
    expect(() => parseModelLods({ file: "a.glb" }, "m")).toThrow('m: "lods" is not a list');
  });
});

describe("modelLodsByFile", () => {
  it("maps each model file to its copies, sorted", () => {
    const iss = [{ file: "ISS-low.glb", maxPoints: 100 }];
    const claims = [
      { modelFile: "ISS.glb", lods: iss, origin: "models.yaml ISS.glb" },
      { modelFile: "AURA.glb", lods: [{ file: "AURA-low.glb", maxPoints: 100 }], origin: "models.yaml AURA.glb" },
      { modelFile: "ISS.glb", lods: iss, origin: "plugin/models.yaml ISS.glb" },
    ];
    expect(Object.keys(modelLodsByFile(claims))).toEqual(["AURA.glb", "ISS.glb"]);
  });

  it("fails on one file with two sets of copies, naming both", () => {
    const claims = [
      { modelFile: "ISS.glb", lods: [{ file: "ISS-low.glb", maxPoints: 100 }], origin: "models.yaml ISS.glb" },
      { modelFile: "ISS.glb", lods: [{ file: "ISS-low.glb", maxPoints: 200 }], origin: "plugin/models.yaml ISS.glb" },
    ];
    expect(() => modelLodsByFile(claims)).toThrow("ISS.glb has different lods in models.yaml ISS.glb and in plugin/models.yaml ISS.glb");
  });
});
