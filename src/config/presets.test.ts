import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { fetchGpIndex, type GpIndex } from "../modules/util/gpSource";
import { presetNameOf, resolvePreset } from "./presets";

vi.mock("../modules/util/gpSource", () => ({ fetchGpIndex: vi.fn() }));

const INDEX: GpIndex = {
  groups: [
    { name: "weather", tags: ["Weather"] },
    { name: "starlink", tags: ["Starlink", "Active"] },
    { name: "ot", tags: ["OT"] },
  ],
  presets: {
    default: { title: "Satvis", defaults: { tags: "Weather" }, groups: [{ name: "weather" }, { name: "starlink" }] },
    ot: { title: "OT Satvis", defaults: { tags: "OT" }, groups: [{ name: "ot" }, { name: "starlink", searchOnly: true }] },
  },
};

beforeEach(() => {
  vi.stubGlobal("document", { title: "Satvis" });
  vi.mocked(fetchGpIndex).mockResolvedValue(INDEX);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("presetNameOf", () => {
  test.each([
    ["/", "default"],
    ["/ot", "ot"],
    ["/ot.html", "ot"],
    ["/index.html", "index"],
  ])("%s names %s", (path, name) => {
    expect(presetNameOf(path)).toBe(name);
  });
});

describe("resolvePreset", () => {
  test("builds the element sets from the groups' tags", async () => {
    expect(await resolvePreset("/")).toEqual({
      name: "default",
      title: "Satvis",
      description: undefined,
      defaults: { tags: "Weather" },
      elements: [
        ["weather", ["Weather"]],
        ["starlink", ["Starlink", "Active"]],
      ],
    });
  });

  test("carries search-only groups", async () => {
    const preset = await resolvePreset("/ot");
    expect(preset.name).toBe("ot");
    expect(preset.elements).toEqual([
      ["ot", ["OT"]],
      ["starlink", ["Starlink", "Active"], { searchOnly: true }],
    ]);
  });

  // `/ot` without the plugin that defines it, and anything inherited from Object.
  test.each(["/move", "/toString", "/ot"])("falls back to the default preset for %s when it names none", async (path) => {
    vi.mocked(fetchGpIndex).mockResolvedValue({ ...INDEX, presets: { default: INDEX.presets.default! } });
    expect((await resolvePreset(path)).name).toBe("default");
  });

  test("registers nothing when the index carries no presets", async () => {
    vi.mocked(fetchGpIndex).mockResolvedValue({ groups: INDEX.groups, presets: {} });
    expect(await resolvePreset("/")).toEqual({ name: "default", title: "Satvis", defaults: {}, elements: [] });
  });
});
