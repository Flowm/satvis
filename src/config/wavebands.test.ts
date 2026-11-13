import { expect, test } from "vitest";

import { WAVEBAND_COLUMNS, wavebandCells } from "./wavebands";

/** The labels of the columns `bands` fill. */
const filled = (bands: string[]) => WAVEBAND_COLUMNS.filter((_, index) => wavebandCells(bands)[index] !== undefined).map((column) => column.label);

test("fills a column per class, every radar band in one, and none for a class it does not know", () => {
  expect(filled(["VIS", "NIR", "SWIR"])).toEqual(["VIS", "NIR", "SWIR"]);
  expect(filled(["MW", "Ku-Band", "C-Band"])).toEqual(["MW", "Radar"]);
  expect(filled(["THz"])).toEqual([]);
});
