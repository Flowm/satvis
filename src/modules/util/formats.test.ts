import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { formatDecimal, formatFixed, formatInteger, formatMeasure, formatNumber, formatWeekdayDate, localeFor, setFormatLocale } from "./formats";

const AT = new Date("2026-10-25T23:30:00Z");

afterAll(() => setFormatLocale("en-US"));

describe("the locale", () => {
  test("is English in the region of the browser's first language", () => {
    expect(localeFor(["de-DE", "en-US"])).toBe("en-DE");
    expect(localeFor(["en-GB"])).toBe("en-GB");
    expect(localeFor(["de"])).toBe("en-DE");
    expect(localeFor(["en"])).toBe("en-US");
    expect(localeFor(["de-CH"])).toBe("en-CH");
  });

  test("is en-US with no language, or one that is not a tag", () => {
    expect(localeFor([])).toBe("en-US");
    expect(localeFor(["not a tag"])).toBe("en-US");
  });
});

describe.each([
  {
    language: "en-US",
    count: "16,819",
    measure: "2,857.123",
    fixed: "1,234.50",
    toFixedRounding: "1.00",
    negative: "-48.14",
    decimal: "12.6",
    weekday: "Sun, Oct 25",
  },
  {
    language: "de-DE",
    count: "16.819",
    measure: "2.857,123",
    fixed: "1.234,50",
    toFixedRounding: "1,00",
    negative: "-48,14",
    decimal: "12,6",
    weekday: "Sun, 25 Oct",
  },
])("in a $language browser", ({ language, ...expected }) => {
  beforeAll(() => setFormatLocale(localeFor([language])));

  test("integers are grouped by the region's separator", () => {
    expect(formatInteger(16819)).toBe(expected.count);
    expect(formatInteger(16818.6)).toBe(expected.count);
  });

  test("a measure keeps three decimals at most", () => {
    expect(formatMeasure(2857.1234)).toBe(expected.measure);
  });

  test("fixed decimals round as toFixed does, in the region's separators", () => {
    expect(formatFixed(1234.5, 2)).toBe(expected.fixed);
    expect(formatFixed(-48.1351, 2)).toBe(expected.negative);
    // 1.005 is 1.00499… in binary: toFixed rounds it down, Intl alone would not.
    expect(formatFixed(1.005, 2)).toBe(expected.toFixedRounding);
  });

  test("a decimal keeps every digit it was written with", () => {
    expect(formatDecimal("12.6")).toBe(expected.decimal);
    expect(formatDecimal("NaN")).toBe("NaN");
    expect(formatNumber(12.6)).toBe(expected.decimal);
  });

  test("the clock's day is in English words, in the region's order, in UTC", () => {
    expect(formatWeekdayDate(AT)).toBe(expected.weekday);
  });
});
