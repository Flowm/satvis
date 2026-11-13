import { expect, test } from "vitest";

import { wavebandColumns } from "./wavebands";

test("fills a column per class, every radar band in one, and none for a class it does not know", () => {
  expect(wavebandColumns(["VIS", "NIR", "SWIR"])).toEqual(new Set(["VIS", "NIR", "SWIR"]));
  expect(wavebandColumns(["MW", "Ku-Band", "C-Band"])).toEqual(new Set(["MW", "Radar"]));
  expect(wavebandColumns(["THz"])).toEqual(new Set());
});
